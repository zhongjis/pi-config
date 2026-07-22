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
import { resumeAgent, runAgent, type ResumeOutcome, type ToolActivity } from "./agent-runner.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import type { AgentRecord, AgentResumeResult, RestoreFailureReason, ResumeTargetV1, SubagentType, ThinkingLevel } from "./types.js";
import { getRecoveredResultText } from "./result-recovery.js";
import { AgentRun, project, type AgentRunTerminalEvent } from "./agent-run.js";
import { SessionRestoreError } from "./session-restoration.js";
import { pandaWarn } from "../../lib/warn.js";
import type { AgentLifecycleLease } from "./lifecycle/agent-lifecycle-store.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;

/** Outcome of a resumed continuation, so resume() can branch success vs. real failure. */
type ContinueOutcome = { ok: true } | { ok: false; reason: RestoreFailureReason; error: string };

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
  /** Commits the next running generation after validation, before any resumed/provider effect. */
  beginResume?: (target: ResumeTargetV1, record: AgentRecord) => Promise<void>;
  /** Commits or repairs one terminal candidate before terminal publication. */
  commitTerminal?: (record: AgentRecord, candidate: AgentRunTerminalEvent) => Promise<void>;
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
  /** Skill names to inject (preload) into the subagent for this call only. See RunOptions.skills. */
  skills?: string[];
  /** Awaited after child session binding/policy, before first prompt. */
  onBeforePrompt?: (record: AgentRecord) => void | Promise<void>;
  /** Awaited after provider settlement, before terminal publication. */
  onBeforeTerminal?: (record: AgentRecord, candidate: AgentRunTerminalEvent) => void | Promise<void>;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  /** Monotonic per-session sum of subagent message cost (USD). Reset on session_start. */
  private lifetimeCost = 0;
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: (record: AgentRecord, data: { reason: string; tokensBefore: number; lease: AgentLifecycleLease }) => void;
  private maxConcurrent: number;
  /** IDs currently opening or continuing; prevents duplicate prompts/restores. */
  private resumeInFlight = new Set<string>();
  /** IDs whose fresh execution has started but not fully settled. */
  private executionInFlight = new Set<string>();
  /** Active executions asked to stop; terminal publication waits for durability. */
  private stopRequests = new Map<string, string>();
  /** Child-session teardowns already detached from records but not yet settled. */
  private pendingTeardowns = new Set<Promise<void>>();

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(onComplete?: OnAgentComplete, maxConcurrent = DEFAULT_MAX_CONCURRENT, onStart?: OnAgentStart, onCompact?: (record: AgentRecord, data: { reason: string; tokensBefore: number; lease: AgentLifecycleLease }) => void) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), SUBAGENT_BACKGROUND_CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref?.();
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
      const stopped = Promise.resolve("").finally(() => this.executionInFlight.delete(id));
      this.executionInFlight.add(id);
      record.promise = stopped;
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

    this.executionInFlight.add(id);
    let durableRunBegun = options.onBeforePrompt === undefined;
    let terminalCommitted = false;
    const promise = runAgent(ctx, type, prompt, {
      pi,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      sessionDir: options.sessionDir,
      skills: options.skills,
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
      onBeforePrompt: async () => {
        await options.onBeforePrompt?.(record);
        durableRunBegun = true;
      },
      onSessionCreated: (session) => {
        record.session = session;
        record.run?.publish({ kind: "session_created", session });
        this.subscribeToCompaction(record, session);
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
      .then(async ({ responseText, session, failure, aborted, steered }) => {
        record.session = session;
        // Read the stop discriminator once; AgentRun owns status past this point.
        const stopError = this.stopRequests.get(id);
        const candidate = this.finalizeRun(record, {
          source: "settled",
          stopped: stopError !== undefined || record.status === "stopped",
          stopError,
          responseText,
          failure,
          aborted,
          steered,
        });
        terminalCommitted = !candidate || await this.publishTerminal(record, candidate, durableRunBegun ? options.onBeforeTerminal : undefined);
        return responseText;
      })
      .catch(async (err) => {
        const stopError = this.stopRequests.get(id);
        const candidate = this.finalizeRun(record, {
          source: "rejected",
          stopped: stopError !== undefined || record.status === "stopped",
          stopError,
          error: err,
        });
        terminalCommitted = !candidate || await this.publishTerminal(record, candidate, durableRunBegun ? options.onBeforeTerminal : undefined);
        if (options.onBeforePrompt && !durableRunBegun) record.session = undefined;
        return "";
      })
      .finally(() => {
        // Background queue bookkeeping: runs once on every settle, regardless of outcome.
        if (options.isBackground) {
          this.runningBackground--;
          if (terminalCommitted) this.onComplete?.(record);
          this.drainQueue();
        }
        if (record.externalAbortCleanup) {
          record.externalAbortCleanup();
          record.externalAbortCleanup = undefined;
        }
        this.executionInFlight.delete(id);
        this.stopRequests.delete(id);
      });

    record.promise = promise;
  }

  private subscribeToCompaction(record: AgentRecord, session: AgentSession): void {
    session.subscribe?.((event: AgentSessionEvent) => {
      if (event.type !== "compaction_end" || event.aborted || !event.result) return;
      const lease = record.lifecycleLease;
      if (!lease) return;
      this.onCompact?.(record, {
        reason: event.reason,
        tokensBefore: event.result.tokensBefore,
        lease,
      });
    });
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
    outcome:
      | { source: "settled"; stopped: boolean; stopError?: string; responseText: string; failure?: string; aborted: boolean; steered: boolean }
      | { source: "rejected"; stopped: boolean; stopError?: string; error: unknown },
  ): AgentRunTerminalEvent | undefined {
    // Flush any streaming output file (common to every terminal path).
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }

    // A pre-start stop is already terminal. Active stops wait for this durable candidate.
    if (outcome.stopped) {
      const base = (outcome.source === "settled" ? outcome.responseText.trim() : "")
        || getRecoveredResultText({ ...record, status: "stopped", error: outcome.stopError });
      if (record.status === "stopped") {
        record.run?.publish({ kind: "result_amended", result: base });
        return undefined;
      }
      return { kind: "aborted", status: "stopped", reason: "user", error: outcome.stopError, result: base };
    }

    if (outcome.source === "settled") {
      const responseText = outcome.responseText.trim();
      if (outcome.aborted) {
        const finalResult = responseText || getRecoveredResultText({ ...record, status: "aborted" });
        return { kind: "aborted", status: "aborted", reason: "max_turns", result: finalResult };
      }
      if (outcome.failure) {
        return { kind: "failed", error: outcome.failure, result: responseText || undefined };
      }
      const finalStatus = outcome.steered ? "steered" : "completed";
      const finalResult = responseText || getRecoveredResultText({ ...record, status: finalStatus });
      return { kind: "completed", result: finalResult, status: finalStatus };
    }

    // Rejected (error).
    const finalError = record.error ?? (outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
    const finalResult = getRecoveredResultText({ ...record, status: "error", error: finalError });
    return { kind: "failed", error: finalError, result: finalResult };
  }

  private async publishTerminal(
    record: AgentRecord,
    candidate: AgentRunTerminalEvent,
    barrier?: (record: AgentRecord, candidate: AgentRunTerminalEvent) => void | Promise<void>,
  ): Promise<boolean> {
    try {
      await barrier?.(record, candidate);
    } catch (error) {
      record.run?.failTerminalCommit(candidate, error);
      return false;
    }
    record.run?.publish(candidate);
    return true;
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
      if (!this.executionInFlight.has(record.id) && !this.resumeInFlight.has(record.id)) {
        this.publishRunStop(record, "Parent tool signal aborted before the agent started.");
        return;
      }
      this.stopRequests.set(record.id, "Parent tool signal aborted while the agent was running.");
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
    if (this.resumeInFlight.has(id) || this.executionInFlight.has(id) || live?.status === "running" || live?.status === "queued") {
      return this.resumeFailure(id, "target_busy", "Agent is already running");
    }
    if (live?.session) {
      if (!this.matchesResumeScope(live.parentSessionId, live.type, request)) {
        return this.resumeFailure(id, "scope_mismatch", "Resume target does not match parent session or agent type", live);
      }
      this.resumeInFlight.add(id);
      try {
        const outcome = await this.continueRecord(live, prompt, request.signal, "live", request);
        if (outcome.ok === false) return this.resumeFailure(id, outcome.reason, outcome.error, live);
        return { status: "resumed_live", id };
      } catch (error) {
        if (!(error instanceof SessionRestoreError)) throw error;
        return this.resumeFailure(id, error.reason, error.message, live);
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
      const outcome = await this.continueRecord(record, prompt, request.signal, "restored", request);
      if (outcome.ok === false) {
        pandaWarn("subagent.restore.failed", {
          id, parent: request.parentSessionId, session: sessionLabel, status: target.state.status, reason: outcome.reason, elapsed: Date.now() - restoreStartedAt,
        });
        return this.resumeFailure(id, outcome.reason, outcome.error, record);
      }
      pandaWarn("subagent.restore.succeeded", {
        id, parent: request.parentSessionId, session: sessionLabel, status: record.status, elapsed: Date.now() - restoreStartedAt,
      });
      return { status: "restored_session", id };
    } catch (error) {
      const reason = error instanceof SessionRestoreError ? error.reason : "runtime_initialization_failed";
      const message = error instanceof Error ? error.message : String(error);
      let failedRecord = record;
      if (record && error instanceof SessionRestoreError && record.resumeSource === undefined && !record.run?.pendingTerminal) {
        await this.removeRecord(id, record);
        failedRecord = undefined;
      }
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
      return this.resumeFailure(id, reason, message, failedRecord);
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
    this.subscribeToCompaction(record, session);
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
    request: AgentRestoreRequest,
  ): Promise<ContinueOutcome> {
    const run = record.run;
    const pendingTerminal = run?.pendingTerminal;
    if (pendingTerminal) {
      if (!request.commitTerminal) {
        throw new SessionRestoreError("persistence_failed", "Execution completed but checkpoint did not persist; terminal repair is unavailable");
      }
      try {
        await request.commitTerminal(record, pendingTerminal);
        run.clearPendingTerminal(pendingTerminal);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new SessionRestoreError("persistence_failed", `Execution completed but checkpoint did not persist; repair failed: ${detail}`);
      }
    }

    if (request.target && request.beginResume) {
      try {
        await request.beginResume(request.target, record);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new SessionRestoreError("persistence_failed", `Failed to persist running resumed generation: ${detail}`);
      }
    }

    record.abortController = new AbortController();
    run?.publish({ kind: "resumed", source, startedAt: Date.now() });
    const continuation = (async (): Promise<ContinueOutcome> => {
      let candidate: AgentRunTerminalEvent;
      let outcome: ContinueOutcome;
      try {
        const result = await resumeAgent(record.session!, prompt, {
          onToolActivity: (activity) => {
            if (activity.type === "end") record.toolUses++;
            run?.publish({ kind: "tool", phase: activity.type, toolName: activity.toolName });
          },
          signal,
        });
        // Legacy callers/mocks may still resolve resumeAgent with a bare string.
        const resumed: ResumeOutcome = typeof result === "string" ? { ok: true, text: result } : result;
        if (!resumed.ok) {
          const finalError = "Resumed turn produced no fresh output";
          const finalResult = getRecoveredResultText({ ...record, status: "error", error: finalError });
          candidate = { kind: "failed", error: finalError, result: finalResult };
          outcome = { ok: false, reason: "runtime_initialization_failed", error: finalError };
        } else {
          const finalResult = resumed.text.trim() || getRecoveredResultText({ ...record, status: "completed" });
          candidate = { kind: "completed", result: finalResult, status: "completed" };
          outcome = { ok: true };
        }
      } catch (error) {
        const finalError = error instanceof Error ? error.message : String(error);
        const finalResult = getRecoveredResultText({ ...record, status: "error", error: finalError });
        candidate = { kind: "failed", error: finalError, result: finalResult };
        // Preserve legacy return for thrown provider failures.
        outcome = { ok: true };
      }

      const stopError = this.stopRequests.get(record.id);
      if (stopError) {
        candidate = { kind: "aborted", status: "stopped", reason: "user", error: stopError, result: candidate.result };
      }
      this.stopRequests.delete(record.id);

      const committed = await this.publishTerminal(record, candidate, request.commitTerminal);
      if (!committed) {
        return {
          ok: false,
          reason: "persistence_failed",
          error: record.error ?? "Execution completed but checkpoint did not persist",
        };
      }
      return outcome;
    })();
    record.promise = continuation.then(() => "", () => "");
    return await continuation;
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
    this.stopRequests.set(id, "Agent was stopped while running.");
    return true;
  }

  /** Shut down and dispose a record's child session exactly once. */
  private teardownRecord(record: AgentRecord): Promise<void> {
    if (record.externalAbortCleanup) {
      record.externalAbortCleanup();
      record.externalAbortCleanup = undefined;
    }

    const session = record.session;
    record.session = undefined;
    if (!session) return Promise.resolve();

    const teardown = (async () => {
      try {
        const runner = session.extensionRunner;
        if (runner?.hasHandlers("session_shutdown")) {
          await runner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        session.dispose();
      }
    })();
    this.pendingTeardowns.add(teardown);
    teardown.then(
      () => this.pendingTeardowns.delete(teardown),
      () => this.pendingTeardowns.delete(teardown),
    );
    return teardown;
  }

  /** Remove a record immediately, then await its detached child-session teardown. */
  private removeRecord(id: string, record: AgentRecord): Promise<void> {
    this.agents.delete(id);
    this.executionInFlight.delete(id);
    this.stopRequests.delete(id);
    return this.teardownRecord(record);
  }

  private cleanup(): void {
    const cutoff = Date.now() - SUBAGENT_BACKGROUND_CLEANUP_AFTER_MS;
    const teardowns: Promise<void>[] = [];
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      teardowns.push(this.removeRecord(id, record));
    }
    void Promise.allSettled(teardowns);
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * @param skipUnconsumed - when true, skip records whose result has not been consumed yet
   */
  async clearCompleted(skipUnconsumed = false): Promise<void> {
    const teardowns: Promise<void>[] = [];
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      teardowns.push(this.removeRecord(id, record));
    }
    await Promise.allSettled(teardowns);
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

  async dispose(): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.queue = [];
    const teardowns = [...this.agents.entries()].map(([id, record]) => this.removeRecord(id, record));
    await Promise.allSettled([...teardowns, ...this.pendingTeardowns]);
  }
}
