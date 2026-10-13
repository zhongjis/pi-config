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
import { openSession, resolveOwnedSessionFile } from "./agent-runner.js";
import { isValidType } from "./agent-types.js";
import { failExecutionStart, type SessionSource, type SteerResult, startExecution, steerExecution, stopExecution, type ToolActivity } from "./execution.js";
import type { CompiledSchema } from "./graph/json-schema.js";
import type { SelectedAgentModel } from "./model-resolution.js";
import type { NestedSpawn } from "./research-delegation.js";
import type { AgentConfig, AgentInvocation, AgentRecord, EvictedAgent, InterruptionCause, SubagentType, ThinkingLevel } from "./types.js";
import type { LifetimeUsage } from "./usage.js";

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

/** Injected agent-history lookup for runs no longer in the live map. */
export type EvictedAgentResolver = (id: string) => EvictedAgent | undefined;

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/** How long terminal agent sessions remain resumable before cleanup. */
const COMPLETED_AGENT_RETENTION_MS = 15 * 60_000;

// ponytail: fixed cap of 3 concurrent `delegate_research` runs per parent run,
// whatever the target; calls over it fail instead of queuing. Upgrade to a
// subagents setting if research fan-out needs more.
const MAX_NESTED_RUNS_PER_PARENT = 3;

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
  /** Internal only (never RPC-reachable): reopen an evicted run under its public id. */
  restore?: { id: string; sessionFile: string; toolUses: number; lifetimeUsage: LifetimeUsage };
  /** Internal only (never RPC-reachable): unregistered definition that replaces registry lookup and delegation policy. */
  agentConfig?: AgentConfig;
  /** Internal only (never RPC-reachable): the root-level record whose `delegate_research` call owns this run. */
  parentAgentId?: string;
}

export interface SpawnOptions {
  /** Internal ownership: the graph runtime owns its independent concurrency pool. */
  graphRunId?: string;
  structuredOutput?: CompiledSchema;
  description: string;
  model?: Model<any>;
  selectedModel?: SelectedAgentModel;
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

const childSessionShutdowns = new WeakMap<AgentSession, Promise<void>>();

/**
 * Dispose a child session like Pi's `AgentSessionRuntime.dispose()`: emit
 * `session_shutdown` (reason "quit") at most once, then dispose even when a
 * handler fails. Sessions without shutdown handlers dispose synchronously.
 */
export function disposeChildSession(session: AgentSession): Promise<void> {
  const pending = childSessionShutdowns.get(session);
  if (pending) return pending;
  let shutdown: Promise<unknown> | undefined;
  try {
    const runner = session.extensionRunner;
    if (runner?.hasHandlers("session_shutdown")) shutdown = runner.emit({ type: "session_shutdown", reason: "quit" });
  } catch {
    // A stale or partial runner must not prevent disposal.
  }
  const done = shutdown
    ? shutdown.catch(() => undefined).then(() => session.dispose?.())
    : Promise.resolve(session.dispose?.());
  childSessionShutdowns.set(session, done);
  return done;
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
  private sessionListener?: (record: AgentRecord) => void;
  private activityListener?: (record: AgentRecord) => void;
  private checkInListener?: (record: AgentRecord, threshold: number) => void;
  private disposed = false;
  /** Independent FIFO pools share a queue; detached spawns have no foreground slot. */
  private queue: { id: string; foreground: boolean; background?: boolean; start: () => void }[] = [];
  private runs = new Map<string, {
    resolve: (result: string) => void;
    detach: () => void;
    pool: "foreground" | "background" | undefined;
    active: boolean;
    /** Waiters this Execution's check-in wakes. */
    checkInWaiters: Set<(threshold: number) => void>;
  }>();
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Injected delegation-policy gate consulted on every spawn (fail-closed). */
  private policyCheck?: SpawnPolicyChecker;
  /** Injected agent-history lookup; wired only by the owning activation. */
  private evictedIndex?: EvictedAgentResolver;
  /** Pending child-session disposals of removed records, keyed by public id. */
  private disposals = new Map<string, Promise<void>>();

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

  setSessionListener(listener: ((record: AgentRecord) => void) | undefined): void {
    this.sessionListener = listener;
  }

  /** Receives an orchestrator check-in that no waiter observed. */
  setCheckInListener(listener: ((record: AgentRecord, threshold: number) => void) | undefined): void {
    this.checkInListener = listener;
  }

  /**
   * Inject a delegation-policy gate consulted on every spawn. Kept as an
   * injected function so the manager never imports session-state itself.
   */
  setPolicyChecker(checker: SpawnPolicyChecker | undefined) {
    this.policyCheck = checker;
  }

  /** Inject the agent-history lookup used to resume runs evicted from the live map. */
  setEvictedIndex(resolver: EvictedAgentResolver | undefined): void {
    this.evictedIndex = resolver;
  }

  /** The history entry for an id with no live record. */
  getEvicted(id: string): EvictedAgent | undefined {
    return this.agents.has(id) ? undefined : this.evictedIndex?.(id);
  }

  /**
   * Resume an evicted run from its persisted session file, with live-resume
   * semantics: same public id, a new execution, background joins the
   * background pool and returns at once, foreground waits outside the
   * foreground pool. Refusals throw before any record exists.
   */
  async restoreEvicted(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    id: string,
    prompt: string,
    options: Pick<SpawnOptions, "isBackground" | "signal" | "onSessionCreated" | "onTextDelta" | "onToolActivity" | "onTurnEnd" | "onAssistantUsage"> = {},
  ): Promise<AgentRecord> {
    if (this.agents.has(id)) throw new Error(`Agent "${id}" is still live; resume its live session instead.`);
    const evicted = this.evictedIndex?.(id);
    if (!evicted) throw new Error(`Agent not found: "${id}". It may have been cleaned up.`);
    if (!isValidType(evicted.type)) {
      throw new Error(`Agent "${id}" cannot be resumed: type "${evicted.type}" is unavailable in the current configuration.`);
    }
    const owned = resolveOwnedSessionFile(ctx, evicted.type, evicted.sessionFile);
    if (owned.ok === false) throw new Error(`Agent "${id}" cannot be resumed: ${owned.reason}.`);
    const isBackground = options.isBackground === true;
    this.spawnRecord({
      pi,
      ctx,
      type: evicted.type,
      prompt,
      options: { ...options, description: evicted.description, isBackground, invocation: { runInBackground: isBackground } },
      restore: { id, sessionFile: owned.file, toolUses: evicted.toolUses, lifetimeUsage: { ...evicted.lifetimeUsage } },
    });
    const record = this.agents.get(id);
    if (!record) throw new Error(`Agent record disappeared: ${id}`);
    if (!isBackground) await record.promise;
    return record;
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

  private registerRun(record: AgentRecord, pool: "foreground" | "background" | undefined): void {
    record.promise = new Promise<string>(resolve => {
      this.runs.set(record.id, { resolve, detach: () => {}, active: false, checkInWaiters: new Set(), pool });
    });
  }

  private attachCallerSignal(id: string, signal?: AbortSignal): void {
    const run = this.runs.get(id);
    if (!signal || !run) return;
    const onAbort = () => this.abort(id, "caller");
    signal.addEventListener("abort", onAbort, { once: true });
    run.detach = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  }

  private spawnRecord(args: SpawnArgs, foreground = false, onSpawned?: (id: string) => void): string {
    const { ctx, type, options, restore, agentConfig } = args;
    if (this.disposed) throw new Error("Agent manager is disposed");
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    // Delegation-policy gate (injected — the manager never reads session state).
    // Fail closed: throw before any record is created so no orphan lands in
    // listAgents() and the RPC layer converts the throw into an error envelope.
    // Internal runtime agents are not delegation targets.
    const policyDenial = agentConfig ? undefined : this.policyCheck?.(ctx, type);
    if (policyDenial) throw new Error(policyDenial);

    const id = restore?.id ?? randomUUID().slice(0, 17);
    if (this.agents.has(id)) throw new Error(`Agent "${id}" is already live.`);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      executionId: randomUUID(),
      resultConsumed: false,
      graphRunId: options.graphRunId,
      parentAgentId: args.parentAgentId,
      cwd: options.cwd ?? ctx.cwd,
      type,
      description: options.description,
      status: "queued",
      toolUses: restore?.toolUses ?? 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: restore?.lifetimeUsage ?? { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      invocation: { ...options.invocation, modelName: undefined, thinking: undefined, fast: undefined },
    };
    this.registerRun(record, options.graphRunId !== undefined ? undefined : options.isBackground ? "background" : foreground ? "foreground" : undefined);
    this.agents.set(id, record);

    try {
      // Registration must precede callbacks, queueing, and even synchronous startup.
      onSpawned?.(id);
      this.attachCallerSignal(id, options.signal);
      if (record.status === "stopped") return id;
      if (options.graphRunId === undefined && !options.bypassQueue && !this.poolHasRoom(foreground, options.isBackground)) {
        this.queue.push({ id, foreground, background: options.isBackground, start: () => this.start(record, { source: this.openSource(record, args), prompt: args.prompt }, options) });
        return id;
      }
      this.start(record, { source: this.openSource(record, args), prompt: args.prompt }, options);
    } catch (err) {
      this.agents.delete(id);
      this.releaseRun(id, record);
      throw err;
    }
    return id;
  }

  setActivityListener(listener: ((record: AgentRecord) => void) | undefined): void {
    this.activityListener = listener;
  }

  /**
   * The create/reopen session source of a spawn or evicted restore. A queued
   * spawn's caller cwd is re-validated here: it can start minutes after
   * spawn()'s check, and the directory may be gone by then (TOCTOU). Same
   * curated errors; drainQueue parks a throw on the record as an error.
   */
  private openSource(record: AgentRecord, { pi, ctx, type, options, restore, agentConfig }: SpawnArgs): SessionSource {
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — both the working
    // dir and configCwd below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    // A reopened file must not race the evicted session's session_shutdown writes.
    const disposal = restore ? this.disposals.get(record.id) : undefined;
    return ({ onToolActivity }) => {
      const open = () => openSession(ctx, type, {
        pi,
        agentId: record.id,
        agentConfig,
        graphRun: options.graphRunId !== undefined,
        structuredOutput: options.structuredOutput,
        model: options.model,
        selectedModel: options.selectedModel,
        isolated: options.isolated,
        inheritContext: options.inheritContext,
        thinkingLevel: options.thinkingLevel,
        // The agent runs at the caller-supplied cwd (undefined → parent cwd, or the
        // reopened session's cwd). When a caller-supplied cwd or a reopened file is
        // in play, config stays with the parent project (configCwd = ctx.cwd);
        // otherwise configCwd stays undefined so config resolves from the working dir.
        cwd: customCwd,
        configCwd: customCwd !== undefined || restore ? ctx.cwd : undefined,
        resumeSessionFile: restore?.sessionFile,
        skills: options.skills,
        parentSessionId: getParentSessionId(ctx),
        nestedSpawn: this.nestedSpawnFor(record, pi, ctx),
        onToolActivity,
      });
      return disposal ? disposal.then(open) : open();
    };
  }

  /**
   * The one start path of every admitted Execution (called immediately or from
   * queue drain): take its pool slot, start it, and own it until Settlement.
   */
  private start(
    record: AgentRecord,
    input: { readonly source: SessionSource; readonly prompt: string },
    options: Pick<SpawnOptions, "onSessionCreated" | "onTextDelta" | "onToolActivity" | "onTurnEnd" | "onAssistantUsage" | "onCompaction">,
  ): void {
    const { source, prompt } = input;
    const run = this.runs.get(record.id);
    if (run) {
      run.active = true;
      if (run.pool === "background") this.runningBackground++;
      if (run.pool === "foreground") this.runningForeground++;
    }
    const opened = typeof source === "function";
    const execution = startExecution(record, {
      onToolActivity: options.onToolActivity,
      onTextDelta: options.onTextDelta,
      onTurnEnd: options.onTurnEnd,
      onAssistantUsage: options.onAssistantUsage,
      onUsage: (usage) => {
        this.lifetimeCost += usage.cost ?? 0;
        this.usageListener?.(usage);
      },
      // Graph-owned and nested owners cannot act on a check-in.
      onCheckIn: record.graphRunId === undefined && record.parentAgentId === undefined
        ? (threshold: number) => this.checkIn(record, threshold)
        : undefined,
      onCompaction: (info) => {
        record.compactionCount++;
        if (record.graphRunId === undefined) this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        // A created or reopened session is new to history; a live resume's is not.
        if (opened) {
          const childSession = session.sessionManager as { isPersisted?: () => boolean; getSessionFile?: () => string | undefined } | undefined;
          const sessionFile = childSession?.isPersisted?.() ? childSession.getSessionFile?.() : undefined;
          if (sessionFile) record.sessionFile = sessionFile;
          if (record.graphRunId === undefined) this.sessionListener?.(record);
        }
        options.onSessionCreated?.(session);
      },
    });
    if (record.graphRunId === undefined) {
      this.activityListener?.(record);
      this.onStart?.(record);
    }
    void execution.run(source, prompt).finally(() => this.completeRun(record));
  }

  /**
   * `delegate_research` bridge for a root-level, non-graph record (depth 1).
   * Each call spawns on this manager with the root ctx, so the mode delegation
   * policy applies; the detached run takes no pool slot and is consumed inline.
   */
  private nestedSpawnFor(record: AgentRecord, pi: ExtensionAPI, ctx: ExtensionContext): NestedSpawn | undefined {
    if (record.graphRunId !== undefined || record.parentAgentId !== undefined) return undefined;
    let active = 0;
    return async ({ type, prompt, description, cwd, signal }) => {
      if (active >= MAX_NESTED_RUNS_PER_PARENT) {
        return { type, status: "denied", text: "", error: `At most ${MAX_NESTED_RUNS_PER_PARENT} delegate_research runs may run at once; wait for one to finish.` };
      }
      active++;
      try {
        const id = this.spawnRecord({ pi, ctx, type, prompt, parentAgentId: record.id, options: { description, cwd, signal, inheritContext: false } });
        const child = this.agents.get(id);
        if (!child) throw new Error(`Agent record disappeared: ${id}`);
        await child.promise;
        return { agentId: id, type, status: child.status, text: child.result ?? "", error: child.error, interruptionCause: child.interruptionCause };
      } catch (error) {
        return { type, status: "error", text: "", error: error instanceof Error ? error.message : String(error) };
      } finally {
        active--;
      }
    };
  }

  private poolHasRoom(foreground: boolean, background?: boolean): boolean {
    if (background) return this.runningBackground < this.maxConcurrent;
    return !foreground || this.maxConcurrentForeground === 0 || this.runningForeground < this.maxConcurrentForeground;
  }

  /** Wake this Execution's active waiters; with none, hand the check-in to the listener. */
  private checkIn(record: AgentRecord, threshold: number): void {
    if (record.status !== "running") return;
    const waiters = this.runs.get(record.id)?.checkInWaiters;
    if (waiters?.size) for (const wake of [...waiters]) wake(threshold);
    else this.checkInListener?.(record, threshold);
  }

  /**
   * Wait for the current Execution's Settlement or its check-in, whichever comes
   * first. Edge-triggered: only waiters active at the check-in wake. Aborting
   * `signal` ends only this wait. `detachCaller` also detaches the caller's abort
   * signal at the check-in, for a foreground call that converts to background.
   * Resolves the check-in threshold, or undefined at Settlement.
   */
  waitForSettlementOrCheckIn(id: string, signal?: AbortSignal, detachCaller = false): Promise<number | undefined> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const settled = this.agents.get(id)?.promise;
    const run = this.runs.get(id);
    const waiters = run?.checkInWaiters;
    return new Promise((resolve, reject) => {
      let open = true;
      const finish = (settle: () => void) => {
        if (!open) return;
        open = false;
        waiters?.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      const wake = (threshold: number) => finish(() => {
        if (detachCaller) run?.detach();
        resolve(threshold);
      });
      const onAbort = () => finish(() => reject(signal?.reason));
      waiters?.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve(settled).then(() => finish(() => resolve(undefined)));
    });
  }

  private completeRun(record: AgentRecord): void {
    if (!record.isBackground || record.graphRunId !== undefined) record.resultConsumed = true;
    try {
      try { record.outputCleanup?.(); } catch (error) {
        record.diagnostics ??= [];
        record.diagnostics.push(`Output cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        record.outputCleanup = undefined;
      }
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
    if (this.disposed) { record.outputCleanup?.(); if (record.session) void disposeChildSession(record.session); }
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
      const index = this.queue.findIndex(entry => this.poolHasRoom(entry.foreground, entry.background));
      if (index === -1) return;
      const [next] = this.queue.splice(index, 1);
      if (!next) return;
      const record = this.agents.get(next.id);
      if (record?.status !== "queued") continue;
      try {
        next.start();
      } catch (err) {
        failExecutionStart(record, err);
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
   * @param untilCheckIn - Also return at this Execution's check-in, detaching the
   *   caller's signal; the run keeps its foreground slot until Settlement.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
    untilCheckIn = false,
  ): Promise<{ id: string; record: AgentRecord; checkIn?: number }> {
    const id = this.spawnRecord({ pi, ctx, type, prompt, options: { ...options, isBackground: false } }, true, onSpawned);
    const record = this.agents.get(id);
    if (!record) throw new Error(`Agent record disappeared: ${id}`);
    if (!untilCheckIn) {
      await record.promise;
      return { id, record };
    }
    const checkIn = await this.waitForSettlementOrCheckIn(id, undefined, true);
    return { id, record, checkIn };
  }

  /**
   * Spawn an unregistered internal agent (graph runtime machinery) and wait for
   * physical settlement. Its definition replaces registry lookup and skips the
   * delegation policy; the caller supplies the exact model and thinking. It runs
   * graph-owned and isolated, without inherited context.
   */
  async spawnInternalAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    agentConfig: AgentConfig,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground"> & { graphRunId: string },
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    const id = this.spawnRecord({
      pi,
      ctx,
      type: agentConfig.name,
      prompt,
      options: { ...options, isBackground: false, isolated: true, inheritContext: false },
      agentConfig,
    }, true, onSpawned);
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
    options: Pick<SpawnOptions, "isBackground" | "onSessionCreated" | "onTextDelta" | "onToolActivity" | "onTurnEnd" | "onAssistantUsage"> = {},
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session || this.disposed) return undefined;
    if (this.runs.has(id)) throw new Error("Agent is already running.");
    if (ctx) {
      const denial = this.policyCheck?.(ctx, record.type);
      if (denial) throw new Error(denial);
    }
    const controller = new AbortController();
    record.executionId = randomUUID();
    record.interruptionCause = undefined;
    record.convertedAtCheckIn = undefined;
    record.resultConsumed = false;
    record.isBackground = options.isBackground === true;
    record.invocation = { ...record.invocation, runInBackground: record.isBackground };
    record.abortController = controller;
    record.status = "queued";
    record.result = undefined;
    record.error = undefined;
    this.registerRun(record, record.isBackground && record.graphRunId === undefined ? "background" : undefined);
    this.attachCallerSignal(id, signal);
    if (record.status === "queued") {
      const start = () => {
        // A live resume starts on its retained session; a start failure fails this record.
        if (!record.session) return;
        try {
          this.start(record, { source: record.session, prompt }, options);
        } catch (err) {
          failExecutionStart(record, err);
          this.completeRun(record);
        }
      };
      if (record.graphRunId === undefined && !this.poolHasRoom(false, record.isBackground)) {
        this.queue.push({ id, foreground: false, background: record.isBackground, start });
      } else start();
    }
    if (!options.isBackground) await record.promise;
    return record;
  }

  /** Accept steering only for queued/running Executions; delivery requires current attachment. */
  steer(id: string, message: string): SteerResult {
    const record = this.agents.get(id);
    return record ? steerExecution(record, message) : { status: "refused" };
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

  abort(id: string, cause: InterruptionCause = "unknown"): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      stopExecution(record, cause);
      this.completeRun(record);
      return true;
    }

    if (record.status !== "running") return false;
    stopExecution(record, cause);
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.outputCleanup?.();
    record.outputCleanup = undefined;
    if (record.session) {
      const disposal = disposeChildSession(record.session).then(() => undefined, () => undefined);
      this.disposals.set(id, disposal);
      void disposal.then(() => { if (this.disposals.get(id) === disposal) this.disposals.delete(id); });
    }
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - COMPLETED_AGENT_RETENTION_MS;
    for (const [id, record] of this.agents) {
      if (this.runs.has(id)) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 15-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (this.runs.has(id)) continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether the manager still owns this execution, including queued or stopped work. */
  hasPendingExecution(id: string): boolean {
    return this.runs.has(id);
  }

  /** Whether any executions remain owned, including stopped work awaiting physical drain. */
  hasRunning(): boolean {
    return this.runs.size > 0;
  }

  /** Abort all running and queued agents immediately. */
  abortAll(cause: InterruptionCause = "unknown"): number {
    let count = 0;
    // Remove the whole queue before settling any entry, so release cannot start a sibling.
    this.queue = [];
    for (const record of this.agents.values()) {
      if (this.abort(record.id, cause)) count++;
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
        .filter(r => this.runs.has(r.id))
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /** Settles after every child session's `session_shutdown` handlers finish and it is disposed. */
  dispose(): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.disposed = true;
    this.abortAll("lifecycle");
    const shutdowns: Promise<void>[] = [];
    for (const record of this.agents.values()) {
      if (this.runs.has(record.id)) {
        shutdowns.push(Promise.resolve(record.promise).then(() => record.session ? disposeChildSession(record.session) : undefined));
      } else if (record.session) shutdowns.push(disposeChildSession(record.session));
    }
    this.agents.clear();
    return Promise.all(shutdowns).then(() => undefined);
  }
}
