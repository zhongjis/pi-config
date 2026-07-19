/**
 * agent-run.ts — Single source of truth for one agent run.
 *
 * AgentRun is the sole writer of run state: all field mutations flow through
 * publish() → apply() → project(run, record). The record is a projection.
 * Every other concern (widget, supervision, external-contract adapter) is a
 * read-only subscriber.
 *
 * The projector subscriber is installed as the FIRST listener at spawn time in
 * agent-manager.ts so every event projects to the record synchronously before
 * any downstream subscriber sees it.
 *
 * See ~/Documents/pi-agent-subagent-revamp/DESIGN-event-taxonomy.md for the
 * verified mapping to the current implementation.
 */

import type { AgentRecord, RestoreFailureReason, ResumeTargetState } from "./types.js";
import type { LifetimeUsage } from "./usage.js";
import { SUBAGENTS_COMPLETED, SUBAGENTS_CREATED, SUBAGENTS_FAILED, SUBAGENTS_STARTED, SUBAGENTS_STEERED } from "../../lib/subagent-channels.js";

/**
 * Run status. Locked to `AgentRecord["status"]` at compile time so the new event
 * stream can never drift from the existing 7-value status union.
 */
export type AgentRunStatus = AgentRecord["status"];

const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  "completed",
  "steered",
  "aborted",
  "stopped",
  "error",
]);

export type SteerOrigin = "user" | "supervision";

/** Why a run was aborted (diagnostic; status is carried explicitly). */
export type AbortReason = "max_turns" | "ceiling" | "user" | "supervision";

/**
 * Ordered event stream for a single agent run. Each variant maps to a real source in
 * the current implementation (see design doc §3). Progress-bearing events carry no
 * timestamp — the run stamps them from an injectable clock for deterministic tests.
 */
export type AgentRunEvent =
  | {
      kind: "created";
      type: string;
      description: string;
      isBackground: boolean;
      startedAt: number;
      maxTurns?: number;
      parentSessionId?: string;
      sessionDir?: string;
      toolCallId?: string;
      modelLabel?: string;
    }
  | { kind: "started"; startedAt: number }
  | {
      kind: "hydrated";
      type: string;
      description: string;
      isBackground: boolean;
      parentSessionId: string;
      sessionDir: string;
      sessionFile: string;
      session: unknown;
      createdAt: number;
      completedAt?: number;
      state: ResumeTargetState;
    }
  | { kind: "restore_started"; at?: number }
  | { kind: "resumed"; source?: "live" | "restored"; startedAt?: number; at?: number }
  | { kind: "restore_failed"; reason: RestoreFailureReason; at?: number }
  | { kind: "session_created"; session: unknown }
  | { kind: "output_file_ready"; outputFile?: string; sessionFile?: string }
  | { kind: "message_start" }
  | { kind: "tool"; phase: "start" | "end"; toolName: string }
  | { kind: "text_delta"; delta: string; fullText: string }
  | { kind: "progress" }
  | { kind: "mark_non_streaming" }
  | { kind: "tokens"; tokens: string }
  | { kind: "turn_end"; turnCount: number }
  | { kind: "steered"; message: string; origin: SteerOrigin; at: number }
  | { kind: "waiter"; delta: 1 | -1 }
  | { kind: "consumed" }
  | { kind: "notified" }
  | { kind: "completed"; result: string; status: "completed" | "steered" }
  | { kind: "aborted"; status: "aborted" | "stopped"; reason: AbortReason; error?: string; result?: string }
  | { kind: "failed"; error: string; result?: string }
  | { kind: "result_amended"; result: string; error?: string };

type TerminalEvent = Extract<AgentRunEvent, { kind: "completed" | "aborted" | "failed" }>;

function isTerminalEvent(event: AgentRunEvent): event is TerminalEvent {
  return event.kind === "completed" || event.kind === "aborted" || event.kind === "failed";
}

/** Live activity, mirrors the fields the existing tracker + supervision care about. */
export interface AgentRunActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  tokens: string;
  responseText: string;
  lastProgressAt: number;
  streamingDeltasSeen: boolean;
  nonStreamingSince?: number;
}

/** Exactly the shape `getBackgroundSupervisionAction` reads as `ActivitySnapshot`. */
export interface ActivitySnapshot {
  lastProgressAt?: number;
  activeTools?: { size: number };
  streamingDeltasSeen?: boolean;
  nonStreamingSince?: number;
}

/** Exactly the shape `getBackgroundSupervisionAction` reads as `RecordSnapshot`. */
export interface RecordSnapshot {
  status: string;
  isBackground?: boolean;
  lastSupervisionSteerAt?: number;
  lastSupervisionAbortAt?: number;
  waitingConsumers?: number;
  startedAt: number;
}

/** Resolved value of {@link AgentRun.waitForTerminal}. */
export interface AgentRunResult {
  status: AgentRunStatus;
  result?: string;
  error?: string;
}

export type AgentRunListener = (event: AgentRunEvent, run: AgentRun) => void;

/**
 * External-contract effect descriptors. The mapping (which effect for which internal
 * event) is pure and unit-tested here; the side-effecting emit + payload construction
 * live in the future `ExternalContractAdapter` (Phase 2), which must be the ONLY
 * subscriber that touches `pi.events` / `appendEntry` for `subagents:*`.
 */
export type ExternalEventName =
  | typeof SUBAGENTS_CREATED
  | typeof SUBAGENTS_STARTED
  | typeof SUBAGENTS_STEERED
  | typeof SUBAGENTS_COMPLETED
  | typeof SUBAGENTS_FAILED;

export type ExternalEffect =
  | { type: "event"; name: ExternalEventName }
  | { type: "record" };

/** Run attributes the external mapping must be aware of to match the current surface. */
export interface ExternalContext {
  isBackground: boolean;
}

/**
 * Pure mapping from an internal event to external-contract effects. Run-aware because
 * the current external surface is asymmetric (verified against source):
 *
 *   - subagents:created            — background only (tools/agent.ts:481, bg branch)
 *   - subagents:started            — ALL runs (agent-manager.ts:144, onStart unconditional)
 *   - subagents:steered            — user-origin only (steer_subagent.ts:40,46; supervision emits none)
 *   - terminal completed/failed
 *     + appendEntry subagents:record — background only (onComplete gated by isBackground,
 *                                       agent-manager.ts:217-219, 247-249)
 *
 * Terminal rule (supervision.ts:482-497): isError = status ∈ {error,stopped,aborted}
 * → subagents:failed, else subagents:completed; record on every terminal.
 */
export function toExternalEffects(event: AgentRunEvent, ctx: ExternalContext): ExternalEffect[] {
  switch (event.kind) {
    case "created":
      return ctx.isBackground ? [{ type: "event", name: SUBAGENTS_CREATED }] : [];
    case "started":
      return [{ type: "event", name: SUBAGENTS_STARTED }];
    case "steered":
      return event.origin === "user" ? [{ type: "event", name: SUBAGENTS_STEERED }] : [];
    case "completed":
      return ctx.isBackground
        ? [{ type: "event", name: SUBAGENTS_COMPLETED }, { type: "record" }]
        : [];
    case "aborted":
    case "failed":
      return ctx.isBackground
        ? [{ type: "event", name: SUBAGENTS_FAILED }, { type: "record" }]
        : [];
    default:
      return [];
  }
}

export interface AgentRunOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * The single source of truth for one agent run. Pure (no pi imports beyond a type),
 * deterministic under an injected clock, and side-effect free except notifying
 * subscribers.
 *
 * Terminal idempotency: once the run reaches a terminal status, further terminal
 * events are ignored ("first terminal wins"), mirroring the real settle guard
 * (`status !== "stopped"`, `completedAt ??=`). A `resumed` event is the only sanctioned
 * way to reopen a terminal run (mirrors `AgentManager.resume`).
 */
export class AgentRun {
  readonly id: string;
  type = "";
  description = "";
  isBackground = false;
  startedAt = 0;
  completedAt?: number;
  status: AgentRunStatus = "queued";
  result?: string;
  error?: string;
  session?: unknown;
  parentSessionId?: string;
  sessionDir?: string;
  sessionFile?: string;
  outputFile?: string;
  toolCallId?: string;
  modelLabel?: string;
  waitingConsumers = 0;
  resultConsumed = false;
  notified = false;
  lifetimeUsage: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
  lifetimeCost = 0;
  compactionCount = 0;
  lastSupervisionSteerAt?: number;
  lastSupervisionAbortAt?: number;
  resumeSource?: "live" | "restored";
  restoreFailureReason?: RestoreFailureReason;
  restoreStartedAt?: number;
  resumedAt?: number;
  restoreFailedAt?: number;
  restoreLatencyMs?: number;
  readonly activity: AgentRunActivity = {
    activeTools: new Map<string, string>(),
    toolUses: 0,
    turnCount: 1,
    tokens: "",
    responseText: "",
    lastProgressAt: 0,
    streamingDeltasSeen: false,
  };

  private readonly now: () => number;
  private readonly log: AgentRunEvent[] = [];
  private readonly listeners = new Set<AgentRunListener>();
  private readonly terminalWaiters = new Set<(value: AgentRunResult) => void>();
  private toolKeySeq = 0;

  constructor(id: string, options: AgentRunOptions = {}) {
    this.id = id;
    this.now = options.now ?? Date.now;
  }

  /**
   * Apply an event to state, append it to the ordered log, then notify subscribers.
   * Duplicate terminal events (after the run is already terminal) are ignored so the
   * external adapter never double-emits.
   */
  publish(event: AgentRunEvent): void {
    if (this.isTerminal() && isTerminalEvent(event)) return;
    this.apply(event);
    this.log.push(event);
    for (const listener of this.listeners) listener(event, this);
    if (this.isTerminal() && this.terminalWaiters.size > 0) {
      const value = this.toResult();
      const waiters = [...this.terminalWaiters];
      this.terminalWaiters.clear();
      for (const resolve of waiters) resolve(value);
    }
  }

  /** Subscribe to the event stream. Returns an unsubscribe function. */
  subscribe(listener: AgentRunListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.status);
  }

  /** Push-based completion: resolves when the run reaches a terminal status. */
  waitForTerminal(): Promise<AgentRunResult> {
    if (this.isTerminal()) return Promise.resolve(this.toResult());
    return new Promise<AgentRunResult>((resolve) => {
      this.terminalWaiters.add(resolve);
    });
  }

  /** Projection consumed by getBackgroundSupervisionAction (ActivitySnapshot). */
  activitySnapshot(): ActivitySnapshot {
    return {
      lastProgressAt: this.activity.lastProgressAt,
      activeTools: { size: this.activity.activeTools.size },
      streamingDeltasSeen: this.activity.streamingDeltasSeen,
      nonStreamingSince: this.activity.nonStreamingSince,
    };
  }

  /** Projection consumed by getBackgroundSupervisionAction (RecordSnapshot). */
  recordSnapshot(): RecordSnapshot {
    return {
      status: this.status,
      isBackground: this.isBackground,
      lastSupervisionSteerAt: this.lastSupervisionSteerAt,
      lastSupervisionAbortAt: this.lastSupervisionAbortAt,
      waitingConsumers: this.waitingConsumers,
      startedAt: this.startedAt,
    };
  }

  /** Read-only ordered event log (durable replay + debugging). */
  events(): readonly AgentRunEvent[] {
    return this.log;
  }

  private toResult(): AgentRunResult {
    return { status: this.status, result: this.result, error: this.error };
  }

  private markProgress(): void {
    this.activity.lastProgressAt = this.now();
  }

  private markStreamingProgress(): void {
    this.activity.streamingDeltasSeen = true;
    this.activity.nonStreamingSince = undefined;
    this.markProgress();
  }

  private apply(event: AgentRunEvent): void {
    switch (event.kind) {
      case "created":
        this.type = event.type;
        this.description = event.description;
        this.isBackground = event.isBackground;
        this.startedAt = event.startedAt;
        this.activity.maxTurns = event.maxTurns;
        this.activity.lastProgressAt = event.startedAt;
        this.parentSessionId = event.parentSessionId;
        this.sessionDir = event.sessionDir;
        this.toolCallId = event.toolCallId;
        this.modelLabel = event.modelLabel;
        this.status = "queued";
        break;
      case "hydrated":
        this.type = event.type;
        this.description = event.description;
        this.isBackground = event.isBackground;
        this.parentSessionId = event.parentSessionId;
        this.sessionDir = event.sessionDir;
        this.sessionFile = event.sessionFile;
        this.session = event.session;
        this.startedAt = event.createdAt;
        this.completedAt = event.completedAt;
        this.status = event.state.status;
        this.resultConsumed = event.state.resultConsumed;
        this.notified = event.state.notified;
        this.activity.toolUses = event.state.toolUses;
        this.lifetimeUsage = { ...event.state.lifetimeUsage };
        this.lifetimeCost = event.state.lifetimeCost;
        this.compactionCount = event.state.compactionCount;
        this.activity.lastProgressAt = event.createdAt;
        break;
      case "started":
        this.status = "running";
        this.startedAt = event.startedAt;
        this.activity.lastProgressAt = event.startedAt;
        break;
      case "restore_started":
        this.restoreStartedAt = event.at ?? this.now();
        this.restoreFailureReason = undefined;
        this.restoreFailedAt = undefined;
        this.restoreLatencyMs = undefined;
        break;
      case "resumed": {
        // A continuation epoch preserves identity, counters, mode, and notification flags.
        const at = event.at ?? this.now();
        this.status = "running";
        this.resumeSource = event.source ?? "live";
        this.restoreFailureReason = undefined;
        this.resumedAt = at;
        this.restoreFailedAt = undefined;
        this.restoreLatencyMs = this.restoreStartedAt === undefined ? undefined : Math.max(0, at - this.restoreStartedAt);
        if (event.startedAt !== undefined) this.startedAt = event.startedAt;
        this.completedAt = undefined;
        this.result = undefined;
        this.error = undefined;
        this.markProgress();
        break;
      }
      case "restore_failed": {
        const at = event.at ?? this.now();
        this.restoreFailureReason = event.reason;
        this.restoreFailedAt = at;
        this.restoreLatencyMs = this.restoreStartedAt === undefined ? undefined : Math.max(0, at - this.restoreStartedAt);
        break;
      }
      case "session_created":
        this.session = event.session;
        this.markProgress();
        break;
      case "output_file_ready":
        if (event.outputFile !== undefined) this.outputFile = event.outputFile;
        if (event.sessionFile !== undefined) this.sessionFile = event.sessionFile;
        break;
      case "message_start":
        this.activity.streamingDeltasSeen = false;
        this.activity.nonStreamingSince = undefined;
        break;
      case "tool":
        if (event.phase === "start") {
          this.activity.activeTools.set(`${event.toolName}_${++this.toolKeySeq}`, event.toolName);
          this.markProgress();
        } else {
          for (const [key, name] of this.activity.activeTools) {
            if (name === event.toolName) {
              this.activity.activeTools.delete(key);
              break;
            }
          }
          this.activity.toolUses++;
        }
        break;
      case "text_delta":
        this.activity.responseText = event.fullText;
        this.markStreamingProgress();
        break;
      case "progress":
        this.markStreamingProgress();
        break;
      case "mark_non_streaming":
        this.activity.nonStreamingSince = this.now();
        break;
      case "tokens":
        this.activity.tokens = event.tokens;
        break;
      case "turn_end":
        this.activity.turnCount = event.turnCount;
        this.markProgress();
        break;
      case "steered":
        if (event.origin === "supervision") this.lastSupervisionSteerAt = event.at;
        break;
      case "waiter":
        this.waitingConsumers = Math.max(0, this.waitingConsumers + event.delta);
        break;
      case "consumed":
        this.resultConsumed = true;
        break;
      case "notified":
        this.notified = true;
        break;
      case "result_amended":
        if (!this.isTerminal()) return; // defense: amends an already-final result only
        this.result = event.result;
        if (event.error !== undefined) this.error = event.error;
        break;
      case "completed":
        this.status = event.status;
        this.result = event.result;
        this.completedAt ??= this.now();
        break;
      case "aborted":
        this.status = event.status;
        this.error = event.error ?? this.error;
        this.result = event.result ?? this.result;
        if (event.reason === "ceiling" || event.reason === "supervision") {
          this.lastSupervisionAbortAt = this.now();
        }
        this.completedAt ??= this.now();
        break;
      case "failed":
        this.status = "error";
        this.error = event.error;
        this.result = event.result ?? this.result;
        this.completedAt ??= this.now();
        break;
    }
  }
}

/**
 * Pure projector: copy run state into the record.
 * Called after each non-terminal start publish and after each terminal publish
 * so record stays consistent with the run (D2/D3b contract). Pure — no events,
 * no side effects.
 *
 * Fields projected: status, result, error, completedAt, startedAt, waiter/notification state.
 */
export function project(run: AgentRun, record: AgentRecord): void {
  record.status = run.status;
  record.result = run.result;
  record.error = run.error;
  record.completedAt = run.completedAt;
  record.startedAt = run.startedAt;
  record.resultConsumed = run.resultConsumed;
  record.notified = run.notified;
  record.resumeSource = run.resumeSource;
  record.restoreFailureReason = run.restoreFailureReason;
  record.waitingConsumers = run.waitingConsumers;
}
