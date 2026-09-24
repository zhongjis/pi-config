/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Blocking foreground calls have an independent optional limit (default: unlimited).
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import type { CompiledSchema } from "./graph/json-schema.js";
import type { SelectedAgentModel } from "./model-resolution.js";
import type { AgentInvocation, AgentRecord, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/**
 * Injected delegation-policy gate. Returns a denial message when a spawn is
 * blocked, or undefined when permitted. Injected from index.ts so the manager
 * never imports session-state or delegation-policy directly.
 */
export type SpawnPolicyChecker = (
  ctx: ExtensionContext,
  type: SubagentType,
) => string | undefined;

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/** How long terminal agent sessions remain resumable before cleanup. */
const COMPLETED_AGENT_RETENTION_MS = 30 * 60_000;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  /** Internal ownership: the workflow runtime owns its independent concurrency pool. */
  graphRunId?: string;
  structuredOutput?: CompiledSchema;
  description: string;
  model?: Model<any>;
  selectedModel?: SelectedAgentModel;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Skill names to inject for this call only. Union with frontmatter preload_skills (deduped). Ignored when isolated: true. */
  skills?: string[];
}

/** Read the parent session ID from the extension context (non-throwing cast). */
function getParentSessionId(ctx: ExtensionContext): string | undefined {
  const sm = ctx.sessionManager as { getSessionId?: () => string | undefined } | undefined;
  return typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private lifetimeCost = 0;
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;

  private maxConcurrentForeground = 0;
  private runningForeground = 0;
  private usageListener?: (usage: LifetimeUsage) => void;
  private disposed = false;
  /** Independent FIFO pools share a queue; detached spawns have no foreground slot. */
  private queue: { id: string; args: SpawnArgs; foreground: boolean }[] = [];
  private runs = new Map<string, {
    resolve: (result: string) => void;
    detach: () => void;
    pool: "foreground" | "background" | undefined;
    active: boolean;
  }>();
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Injected delegation-policy gate consulted on every spawn (fail-closed). */
  private policyCheck?: SpawnPolicyChecker;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    // Keep completed agent sessions available for resume until retention expires.
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
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

  setMaxConcurrentForeground(n: number): void {
    this.maxConcurrentForeground = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.maxConcurrentForeground;
  }

  setUsageListener(listener: ((usage: LifetimeUsage) => void) | undefined): void {
    this.usageListener = listener;
  }

  /**
   * Inject a delegation-policy gate consulted on every spawn. Kept as an
   * injected function so the manager never imports session-state itself.
   */
  setPolicyChecker(checker: SpawnPolicyChecker | undefined) {
    this.policyCheck = checker;
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
    return this.spawnRecord({ pi, ctx, type, prompt, options });
  }

  private spawnRecord(args: SpawnArgs, foreground = false, onSpawned?: (id: string) => void): string {
    const { ctx, type, options } = args;
    if (this.disposed) throw new Error("Agent manager is disposed");
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    // Delegation-policy gate (injected — the manager never reads session state).
    // Fail closed: throw before any record is created so no orphan lands in
    // listAgents() and the RPC layer converts the throw into an error envelope.
    const policyDenial = this.policyCheck?.(ctx, type);
    if (policyDenial) throw new Error(policyDenial);

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      graphRunId: options.graphRunId,
      cwd: options.cwd ?? ctx.cwd,
      type,
      description: options.description,
      status: "queued",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      invocation: { ...options.invocation, modelName: undefined, thinking: undefined },
      maxTurns: options.maxTurns,
    };
    record.promise = new Promise<string>(resolve => {
      this.runs.set(id, {
        resolve, detach: () => {}, active: false,
        pool: options.graphRunId !== undefined ? undefined : options.isBackground ? "background" : foreground ? "foreground" : undefined,
      });
    });
    this.agents.set(id, record);

    try {
      // Registration must precede callbacks, queueing, and even synchronous startup.
      onSpawned?.(id);
      const signal = options.signal;
      const run = this.runs.get(id);
      if (signal && run) {
        const onAbort = () => this.abort(id);
        signal.addEventListener("abort", onAbort, { once: true });
        run.detach = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) this.abort(id);
      }
      if (record.status === "stopped") return id;
      if (options.graphRunId === undefined && !options.bypassQueue && !this.poolHasRoom(foreground, options.isBackground)) {
        this.queue.push({ id, args, foreground });
        return id;
      }
      this.startAgent(id, record, args);
    } catch (err) {
      this.agents.delete(id);
      this.releaseRun(id, record);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — both the working
    // dir and configCwd below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined

    record.status = "running";
    record.startedAt = Date.now();
    const run = this.runs.get(id);
    if (run) {
      run.active = true;
      if (run.pool === "background") this.runningBackground++;
      if (run.pool === "foreground") this.runningForeground++;
    }
    if (record.graphRunId === undefined) this.onStart?.(record);

    void runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      graphRun: options.graphRunId !== undefined,
      structuredOutput: options.structuredOutput,
      model: options.model,
      selectedModel: options.selectedModel,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      // The agent runs at the caller-supplied cwd (undefined → parent cwd). When
      // a caller-supplied cwd is in play, config stays with the parent project
      // (configCwd = ctx.cwd); otherwise configCwd stays undefined so config
      // resolves from the working dir.
      cwd: customCwd,
      configCwd: customCwd !== undefined ? ctx.cwd : undefined,
      signal: record.abortController!.signal,
      skills: options.skills,
      parentSessionId: getParentSessionId(ctx),
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        if (activity.type === "diagnostic") {
          record.diagnostics ??= [];
          record.diagnostics.push(activity.toolName);
        }
        options.onToolActivity?.(activity);
      },
      onTurnEnd: (turnCount) => {
        record.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        record.lifetimeCost = (record.lifetimeCost ?? 0) + (usage.cost ?? 0);
        this.lifetimeCost += usage.cost ?? 0;
        this.usageListener?.(usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        if (record.graphRunId === undefined) this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        record.session = session;
        record.invocation = {
          ...record.invocation,
          modelName: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
          thinking: session.thinkingLevel,
        };
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
      .then(({ responseText, session, aborted, steered, failure, structuredJson, structuredRetried }) => {
        record.structuredJson = structuredJson;
        record.structuredRetried = structuredRetried;
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.result = responseText;
        record.session = session;
        record.invocation = {
          ...record.invocation,
          modelName: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
          thinking: session.thinkingLevel,
        };
        record.completedAt ??= Date.now();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        return "";
      })
      .finally(() => this.completeRun(record));
  }

  private poolHasRoom(foreground: boolean, background?: boolean): boolean {
    if (background) return this.runningBackground < this.maxConcurrent;
    return !foreground || this.maxConcurrentForeground === 0 || this.runningForeground < this.maxConcurrentForeground;
  }

  private completeRun(record: AgentRecord): void {
    if (!record.isBackground || record.graphRunId !== undefined) record.resultConsumed = true;
    try {
      if (record.graphRunId === undefined) this.onComplete?.(record);
    } catch (error) {
      // Notification failures are diagnostics, never failures of the child run.
      record.diagnostics ??= [];
      record.diagnostics.push(`Completion callback failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.releaseRun(record.id, record);
    }
  }

  private releaseRun(id: string, record: AgentRecord): void {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.delete(id);
    if (this.disposed) { record.outputCleanup?.(); record.session?.dispose(); }
    run.detach();
    if (run.active) {
      if (run.pool === "background") this.runningBackground--;
      if (run.pool === "foreground") this.runningForeground--;
    }
    run.resolve(record.result ?? "");
    this.drainQueue();
  }

  /** Start the earliest eligible entry, preserving FIFO within each pool. */
  private drainQueue(): void {
    if (this.disposed) return;
    for (;;) {
      const index = this.queue.findIndex(entry => this.poolHasRoom(entry.foreground, entry.args.options.isBackground));
      if (index === -1) return;
      const [next] = this.queue.splice(index, 1);
      if (!next) return;
      const record = this.agents.get(next.id);
      if (record?.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.completeRun(record);
      }
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Only blocking calls use the foreground pool; detached spawn/resume bypass it.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
   *   Use this to set record.outputFile so streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    const id = this.spawnRecord({ pi, ctx, type, prompt, options: { ...options, isBackground: false } }, true, onSpawned);
    const record = this.agents.get(id);
    if (!record) throw new Error(`Agent record disappeared: ${id}`);
    await record.promise;
    return { id, record };
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    ctx?: ExtensionContext,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session || this.disposed) return undefined;
    if (this.runs.has(id)) throw new Error("Agent is already running.");
    if (ctx) {
      const denial = this.policyCheck?.(ctx, record.type);
      if (denial) throw new Error(denial);
    }
    const controller = new AbortController();
    record.abortController = controller;
    const parentSignal = signal;
    const onAbort = () => this.abort(id);
    record.promise = new Promise<string>(resolve => {
      this.runs.set(id, { resolve, active: true, pool: undefined,
        detach: () => parentSignal?.removeEventListener("abort", onAbort) });
    });
    signal = controller.signal;
    record.structuredJson = undefined;
    record.structuredRetried = undefined;

    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.invocation = {
      ...record.invocation,
      modelName: record.session.model ? `${record.session.model.provider}/${record.session.model.id}` : undefined,
      thinking: record.session.thinkingLevel,
    };

    parentSignal?.addEventListener("abort", onAbort, { once: true });
    if (parentSignal?.aborted) onAbort();
    const previousTurns = record.turnCount ?? 0;
    try {
      const { text, failure, structuredJson, structuredRetried } = await resumeAgent(record.session, prompt, {
        onTurnEnd: (turnCount) => { record.turnCount = previousTurns + turnCount; },
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          if (activity.type === "diagnostic") {
            record.diagnostics ??= [];
            record.diagnostics.push(activity.toolName);
          }
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          record.lifetimeCost = (record.lifetimeCost ?? 0) + (usage.cost ?? 0);
          this.lifetimeCost += usage.cost ?? 0;
          this.usageListener?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          if (record.graphRunId === undefined) this.onCompact?.(record, info);
        },
        signal,
      });
      // Same contract as the spawn path (#144): a failed final turn is an
      // error, not a completion — but the resumed text stays available.
      record.structuredJson = structuredJson;
      record.structuredRetried = structuredRetried;
      record.status = signal.aborted ? "stopped" : failure ? "error" : "completed";
      if (failure) record.error = failure;
      record.result = text;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = signal.aborted ? "stopped" : "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    } finally {
      this.releaseRun(id, record);
    }

    return record;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getLifetimeCost(): number {
    return this.lifetimeCost;
  }

  resetLifetimeCost(): void {
    this.lifetimeCost = 0;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  /** Records currently executing (status === "running"). Used by background supervision. */
  getRunning(): AgentRecord[] {
    return [...this.agents.values()].filter((r) => r.graphRunId === undefined && r.status === "running");
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      record.abortController?.abort();
      this.releaseRun(id, record);
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.outputCleanup?.();
    record.outputCleanup = undefined;
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - COMPLETED_AGENT_RETENTION_MS;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 30-minute cleanup timer instead.
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
    // Remove the whole queue before settling any entry, so release cannot start a sibling.
    this.queue = [];
    for (const record of this.agents.values()) {
      if (record.status === "queued" && this.abort(record.id)) count++;
    }
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
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
    this.disposed = true;
    this.abortAll();
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
  }
}
