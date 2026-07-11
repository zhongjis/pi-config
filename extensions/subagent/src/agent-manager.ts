/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_BACKGROUND_CLEANUP_AFTER_MS, SUBAGENT_BACKGROUND_CLEANUP_INTERVAL_MS, SUBAGENT_BACKGROUND_MAX_CONCURRENT } from "./constants.js";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import type { AgentRecord, AgentResumeResult, RestoreFailureReason, ResumeTargetV1, SubagentType, ThinkingLevel } from "./types.js";
import { getRecoveredResultText } from "./result-recovery.js";
import { AgentRun, project } from "./agent-run.js";
import { SessionRestoreError } from "./session-restoration.js";
import { pandaWarn } from "../../lib/warn.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = SUBAGENT_BACKGROUND_MAX_CONCURRENT;

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface AgentRestoreRequest {
  parentSessionId: string;
  expectedType: SubagentType;
  target?: ResumeTargetV1;
  signal?: AbortSignal;
  /** Opens the validated durable target through the T3 restoration service. */
  restoreSession: (target: ResumeTargetV1) => Promise<AgentSession>;
  /** Optional durable generation writer; called before prompt and after settlement. */
  persist?: (target: ResumeTargetV1, record: AgentRecord) => Promise<void>;
}

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /** Parent session id for durable subagent linkage. */
  parentSessionId?: string;
  /** Directory for persistent subagent session JSONL files. */
  sessionDir?: string;
  /** Resolved provider/model label for widget display. */
  modelLabel?: string;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when reasoning/thinking deltas indicate model progress. */
  onProgress?: () => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  /** Monotonic per-session sum of subagent message cost (USD). Reset on session_start. */
  private lifetimeCost = 0;
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: (record: AgentRecord, data: { reason: string; tokensBefore: number }) => void;
  private maxConcurrent: number;
  /** IDs currently opening or continuing; prevents duplicate prompts/restores. */
  private resumeInFlight = new Set<string>();

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(onComplete?: OnAgentComplete, maxConcurrent = DEFAULT_MAX_CONCURRENT, onStart?: OnAgentStart, onCompact?: (record: AgentRecord, data: { reason: string; tokensBefore: number }) => void) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), SUBAGENT_BACKGROUND_CLEANUP_INTERVAL_MS);
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Total subagent cost (USD) accrued this session, across live and cleaned-up agents. */
  getLifetimeCost(): number {
    return this.lifetimeCost;
  }

  /** Reset the per-session subagent cost accumulator (called on session_start). */
  resetLifetimeCost(): void {
    this.lifetimeCost = 0;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      modelLabel: options.modelLabel,
      isBackground: options.isBackground,
      parentSessionId: options.parentSessionId,
      sessionDir: options.sessionDir,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } satisfies LifetimeUsage,
      lifetimeCost: 0,
      compactionCount: 0,
    };
    record.run = new AgentRun(id);
    // Projector must be the first subscriber so every event projects before downstream readers.
    record.run.subscribe((_event, run) => project(run, record));
    record.run.publish({
      kind: "created",
      type,
      description: options.description,
      isBackground: options.isBackground ?? false,
      startedAt: record.startedAt,
      maxTurns: options.maxTurns,
      parentSessionId: options.parentSessionId,
      sessionDir: options.sessionDir,
      modelLabel: options.modelLabel,
    });
    this.agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (options.isBackground && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
      record.externalAbortCleanup = this.bindExternalAbortSignal(record, options.signal);
      return id;
    }

    record.externalAbortCleanup = this.bindExternalAbortSignal(record, options.signal);
    if (record.status === "stopped") {
      record.promise = Promise.resolve("");
      return id;
    }

    this.startAgent(id, record, args);
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    const startedAt = Date.now();
    record.run?.publish({ kind: "started", startedAt });
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);


    const promise = runAgent(ctx, type, prompt, {
      pi,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      sessionDir: options.sessionDir,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        record.run?.publish({ kind: "tool", phase: activity.type, toolName: activity.toolName });
        options.onToolActivity?.(activity);
      },
      onTurnEnd: (turnCount) => {
        record.run?.publish({ kind: "turn_end", turnCount });
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: (delta, fullText) => {
        record.run?.publish({ kind: "text_delta", delta, fullText });
        options.onTextDelta?.(delta, fullText);
      },
      onProgress: () => {
        record.run?.publish({ kind: "progress" });
        options.onProgress?.();
      },
      onAssistantUsage: (usage) => {
        if (record.lifetimeUsage) addUsage(record.lifetimeUsage, usage);
        record.lifetimeCost = (record.lifetimeCost ?? 0) + (usage.cost ?? 0);
        this.lifetimeCost += usage.cost ?? 0;
      },
      onSessionCreated: (session) => {
        record.session = session;
        record.run?.publish({ kind: "session_created", session });
        // Subscribe to compaction events for observability
        session.subscribe?.((event: AgentSessionEvent) => {
          if (event.type === "compaction_end" && !event.aborted && event.result) {
            record.compactionCount = (record.compactionCount ?? 0) + 1;
            this.onCompact?.(record, { reason: event.reason, tokensBefore: event.result.tokensBefore });
          }
        });
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered }) => {
        record.session = session;
        // Read the stop discriminator once; AgentRun owns status past this point.
        const stopped = record.status === "stopped";
        this.finalizeRun(record, ctx, options.description, {
          source: "settled",
          stopped,
          responseText,
          aborted,
          steered,
        });
        return responseText;
      })
      .catch((err) => {
        const stopped = record.status === "stopped";
        this.finalizeRun(record, ctx, options.description, {
          source: "rejected",
          stopped,
          error: err,
        });
        return "";
      })
      .finally(() => {
        // Background queue bookkeeping: runs once on every settle, regardless of outcome.
        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        if (record.externalAbortCleanup) {
          record.externalAbortCleanup();
          record.externalAbortCleanup = undefined;
        }
      });

    record.promise = promise;
  }

  /**
   * Own the terminal handling for a run: flush streaming output,
   * derive the final result text, and publish the single terminal AgentRun event.
   * The four former in-`startAgent` blocks (then/catch × normal/stopped) all route here.
   *
   * Variation is carried entirely by `outcome`:
   *  - source "settled" (runAgent resolved) vs "rejected" (threw): governs the
   *    result-derivation source.
   *  - stopped (read ONCE by the caller before this runs): a user-stopped run only amends its
   *    already-final result; AgentRun owns status/error/completedAt, so no status re-derivation.
   *
   * Out of scope (stays in startAgent): queue bookkeeping and externalAbortCleanup.
   */
  private finalizeRun(
    record: AgentRecord,
    ctx: ExtensionContext,
    description: string,
    outcome:
      | { source: "settled"; stopped: boolean; responseText: string; aborted: boolean; steered: boolean }
      | { source: "rejected"; stopped: boolean; error: unknown },
  ): void {
    // Flush any streaming output file (common to every terminal path).
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }

    // Stopped: AgentRun already owns status/error/completedAt (set when the stop was published).
    // Only amend the final result text.
    if (outcome.stopped) {
      const base = (outcome.source === "settled" ? outcome.responseText.trim() : "")
        || getRecoveredResultText(record);
      record.run?.publish({ kind: "result_amended", result: base });
      return;
    }

    if (outcome.source === "settled") {
      const finalStatus = outcome.aborted ? "aborted" : outcome.steered ? "steered" : "completed";
      const base = outcome.responseText.trim() || getRecoveredResultText({ ...record, status: finalStatus });
      const finalResult = base;
      if (finalStatus === "completed" || finalStatus === "steered") {
        record.run?.publish({ kind: "completed", result: finalResult, status: finalStatus });
      } else {
        record.run?.publish({ kind: "aborted", status: "aborted", reason: "max_turns", result: finalResult });
      }
      return;
    }

    // Rejected (error).
    const finalError = record.error ?? (outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
    const finalResult = getRecoveredResultText({ ...record, status: "error", error: finalError });
    record.run?.publish({ kind: "failed", error: finalError, result: finalResult });
  }

  /** Forward an outer tool abort signal into this agent's internal abort controller. */
  private bindExternalAbortSignal(record: AgentRecord, signal?: AbortSignal): () => void {
    if (!signal) return () => {};

    const onAbort = () => {
      if (record.status === "queued") {
        this.queue = this.queue.filter(q => q.id !== record.id);
        this.publishRunStop(record, "Parent tool signal aborted before the queued agent could start.");
        return;
      }
      if (record.status !== "running") return;
      record.abortController?.abort();
      this.publishRunStop(record, "Parent tool signal aborted while the agent was running.");
    };

    if (signal.aborted) {
      onAbort();
      return () => {};
    }

    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }

  /** Phase 1 (dormant): mirror an external/forced stop into the AgentRun. */
  private publishRunStop(record: AgentRecord, message?: string): void {
    record.run?.publish({ kind: "aborted", status: "stopped", reason: "user", error: record.error ?? message });
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      this.startAgent(next.id, record, next.args);
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  /** Resume a live session first, otherwise rehydrate the same logical ID from a durable target. */
  async resume(
    id: string,
    prompt: string,
    request: AgentRestoreRequest,
  ): Promise<AgentResumeResult> {
    const live = this.agents.get(id);
    if (this.resumeInFlight.has(id) || live?.status === "running" || live?.status === "queued") {
      return this.resumeFailure(id, "target_busy", "Agent is already running");
    }
    if (live?.session) {
      if (!this.matchesResumeScope(live.parentSessionId, live.type, request)) {
        return this.resumeFailure(id, "scope_mismatch", "Resume target does not match parent session or agent type", live);
      }
      this.resumeInFlight.add(id);
      try {
        await this.continueRecord(live, prompt, request.signal, "live", request.target, request.persist);
        return { status: "resumed_live", id };
      } finally {
        this.resumeInFlight.delete(id);
      }
    }

    const target = request.target;
    if (!target || target.id !== id) {
      return this.resumeFailure(id, "target_unknown", "Durable resume target was not found");
    }
    if (target.parentSessionId !== request.parentSessionId ||
        target.type.toLocaleLowerCase() !== request.expectedType.toLocaleLowerCase()) {
      return this.resumeFailure(id, "scope_mismatch", "Resume target does not match parent session or agent type");
    }

    const restoreStartedAt = Date.now();
    const sessionLabel = this.redactSessionId(target.childSessionId);
    pandaWarn("subagent.restore.started", { id, parent: request.parentSessionId, session: sessionLabel, status: target.state.status, elapsed: 0 });
    this.resumeInFlight.add(id);
    let record: AgentRecord | undefined;
    try {
      const session = await request.restoreSession(target);
      record = this.hydrateRecord(target, session);
      this.agents.set(id, record);
      if (request.persist) {
        try {
          await request.persist(target, record);
        } catch {
          throw new SessionRestoreError("persistence_failed", "Failed to persist running restored generation");
        }
      }
      await this.continueRecord(record, prompt, request.signal, "restored", target, request.persist);
      pandaWarn("subagent.restore.succeeded", {
        id, parent: request.parentSessionId, session: sessionLabel, status: record.status, elapsed: Date.now() - restoreStartedAt,
      });
      return { status: "restored_session", id };
    } catch (error) {
      const reason = error instanceof SessionRestoreError ? error.reason : "runtime_initialization_failed";
      const message = error instanceof Error ? error.message : String(error);
      if (record && !(error instanceof SessionRestoreError)) {
        // Prompt failures are normal run failures after a successful open, never restore failures.
        pandaWarn("subagent.restore.succeeded", {
          id, parent: request.parentSessionId, session: sessionLabel, status: record.status, elapsed: Date.now() - restoreStartedAt,
        });
        return { status: "restored_session", id };
      }
      pandaWarn("subagent.restore.failed", {
        id, parent: request.parentSessionId, session: sessionLabel, status: target.state.status, reason, elapsed: Date.now() - restoreStartedAt,
      });
      return this.resumeFailure(id, reason, message, record);
    } finally {
      this.resumeInFlight.delete(id);
    }
  }

  private matchesResumeScope(parentSessionId: string | undefined, type: string, request: AgentRestoreRequest): boolean {
    return (parentSessionId ?? "") === request.parentSessionId && type.toLocaleLowerCase() === request.expectedType.toLocaleLowerCase();
  }

  private resumeFailure(id: string, reason: RestoreFailureReason, error: string, record?: AgentRecord): AgentResumeResult {
    record?.run?.publish({ kind: "restore_failed", reason });
    return { status: "failed", id, reason, error };
  }

  private redactSessionId(sessionId: string): string {
    return sessionId.length <= 8 ? "[redacted]" : `…${sessionId.slice(-8)}`;
  }

  private hydrateRecord(target: ResumeTargetV1, session: AgentSession): AgentRecord {
    const record: AgentRecord = {
      id: target.id,
      type: target.type,
      description: target.description,
      status: target.state.status,
      toolUses: target.state.toolUses,
      startedAt: target.createdAt,
      resultConsumed: target.state.resultConsumed,
      notified: target.state.notified,
      session,
      abortController: new AbortController(),
      isBackground: target.isBackground,
      parentSessionId: target.parentSessionId,
      sessionDir: target.sessionDir,
      sessionFile: target.sessionFile,
      lifetimeUsage: { ...target.state.lifetimeUsage },
      lifetimeCost: target.state.lifetimeCost,
      compactionCount: target.state.compactionCount,
    };
    record.run = new AgentRun(target.id);
    record.run.subscribe((_event, run) => project(run, record));
    record.run.publish({
      kind: "hydrated",
      type: target.type,
      description: target.description,
      isBackground: target.isBackground,
      parentSessionId: target.parentSessionId,
      sessionDir: target.sessionDir,
      sessionFile: target.sessionFile,
      session,
      createdAt: target.createdAt,
      completedAt: target.state.status === "completed" || target.state.status === "steered" ||
        target.state.status === "aborted" || target.state.status === "stopped" || target.state.status === "error"
        ? target.updatedAt
        : undefined,
      state: target.state,
    });
    record.run.publish({ kind: "restore_started" });
    return record;
  }

  private async continueRecord(
    record: AgentRecord,
    prompt: string,
    signal: AbortSignal | undefined,
    source: "live" | "restored",
    target?: ResumeTargetV1,
    persist?: AgentRestoreRequest["persist"],
  ): Promise<void> {
    record.abortController = new AbortController();
    record.run?.publish({ kind: "resumed", source, startedAt: Date.now() });
    const continuation = resumeAgent(record.session!, prompt, {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        record.run?.publish({ kind: "tool", phase: activity.type, toolName: activity.toolName });
      },
      signal,
    })
      .then((responseText) => {
        const finalResult = responseText.trim() || getRecoveredResultText({ ...record, status: "completed" });
        record.run?.publish({ kind: "completed", result: finalResult, status: "completed" });
        return responseText;
      })
      .catch((error) => {
        const finalError = error instanceof Error ? error.message : String(error);
        const finalResult = getRecoveredResultText({ ...record, status: "error", error: finalError });
        record.run?.publish({ kind: "failed", error: finalError, result: finalResult });
        return "";
      })
      .then(async (responseText) => {
        if (target && persist) {
          try {
            await persist(target, record);
          } catch {
            throw new SessionRestoreError("persistence_failed", "Failed to persist terminal restored generation");
          }
        }
        return responseText;
      });
    record.promise = continuation;
    await continuation;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      this.publishRunStop(record, "Agent was stopped before it started running.");
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    this.publishRunStop(record, "Agent was stopped while running.");
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    if (record.externalAbortCleanup) {
      record.externalAbortCleanup();
      record.externalAbortCleanup = undefined;
    }
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - SUBAGENT_BACKGROUND_CLEANUP_AFTER_MS;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * @param skipUnconsumed - when true, skip records whose result has not been consumed yet
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        this.publishRunStop(record, "Agent was stopped before it started running.");
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        this.publishRunStop(record, "Agent was stopped while running.");
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      if (record.externalAbortCleanup) {
        record.externalAbortCleanup();
        record.externalAbortCleanup = undefined;
      }
      record.session?.dispose();
    }
    this.agents.clear();
  }
}
