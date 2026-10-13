/**
 * execution.ts — one Execution on an attached session: subscribe, prompt,
 * drain, and derive the outcome; and the sole writer of the record's terminal
 * fields (status, result, error, interruption cause, completion time,
 * structured output, and the session label). Knows nothing about graphs,
 * pools, or manager ownership.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { extractText } from "./context.js";
import { getSessionFast } from "./session-fast.js";
import { repairStructuredOutput, resetStructuredCapture, structuredFailure, takeStructuredCapture } from "./structured-output.js";
import { parseTurnCeiling, watchTurns } from "./turn-ceiling.js";
import type { AgentActivity, AgentRecord, InterruptionCause } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end" | "diagnostic";
  toolName: string;
}

/** Caller hooks for one Execution. */
export interface ExecutionHooks {
  signal?: AbortSignal;
  /** Called with the attached session before the Execution subscribes. */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Internal idle heartbeat for non-empty thinking/tool-call argument deltas; carries no payload. */
  onProgress?: () => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Orchestrator check-in; the manager supplies it only for orchestrator-owned runs. */
  onCheckIn?: (threshold: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers accumulate observed billing deltas independently of history.
   * SDK session stats also retain pre-compaction usage via session entries.
   */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

export interface ExecutionOutcome {
  /** This Execution's final assistant text; never a prior Execution's (#144). */
  text: string;
  interruptionCause?: InterruptionCause;
  /** True when the agent got the turn-ceiling wrap-up reminder and finished in time. */
  forceSteered: boolean;
  /** Final provider/runtime failure; partial output remains available separately. */
  failure?: string;
  structuredJson?: string;
  structuredRetried: boolean;
}

/** An opened session; create mode also carries the parent-context prompt prefix. */
export interface OpenedSession {
  session: AgentSession;
  promptPrefix?: string;
}

/**
 * Where an Execution's session comes from: the live session of a resume, or an
 * unopened create/reopen source. A source receives the Execution's tool-activity
 * hook so setup diagnostics land on the record.
 */
export type SessionSource = AgentSession | ((setup: { onToolActivity: (activity: ToolActivity) => void }) => Promise<OpenedSession>);

/** Caller and owner hooks for one Execution on a record. */
export interface ExecutionCallbacks {
  /** Called at attach, after the Execution attached the session to the record. */
  onSessionCreated?: (session: AgentSession) => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  onCompaction?: ExecutionHooks["onCompaction"];
  /** Orchestrator check-in; the owner supplies it only for orchestrator-owned runs. */
  onCheckIn?: (threshold: number) => void;
  /** Owner accounting for each assistant usage delta, after the record's own. */
  onUsage?: (usage: LifetimeUsage) => void;
}

/** The record fields an Execution writes. */
export type ExecutionRecord = Pick<AgentRecord,
  "status" | "startedAt" | "completedAt" | "result" | "error" | "interruptionCause"
  | "structuredJson" | "structuredRetried" | "invocation" | "abortController" | "session" | "pendingSteers"
  | "activity" | "lastSupervisionSteerAt" | "lastSupervisionAbortAt" | "toolUses" | "diagnostics" | "turnCount"
  | "lifetimeUsage" | "lifetimeCost">;

/** A started Execution; `run` resolves at Settlement and never rejects. */
export interface Execution {
  run(source: SessionSource, prompt: string): Promise<void>;
}

/** Label the record with the session's effective model, thinking, and Fast. */
function labelExecution(record: ExecutionRecord, session: AgentSession): void {
  record.invocation = {
    ...record.invocation,
    modelName: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
    thinking: session.thinkingLevel,
    fast: getSessionFast(session),
  };
}

/**
 * Give the record a fresh execution view without resetting lifetime accounting,
 * and return the hooks that keep it current.
 */
function trackActivity(record: ExecutionRecord, callbacks: ExecutionCallbacks) {
  const previousTurns = record.turnCount ?? 0;
  const state: AgentActivity = {
    activeTools: new Map(),
    responseText: "",
    lastProgressAt: record.startedAt,
    maxTurns: parseTurnCeiling(),
    get toolUses() { return record.toolUses; },
    get turnCount() { return record.turnCount ?? 1; },
    get session() { return record.session; },
    lifetimeUsage: record.lifetimeUsage,
  };
  record.activity = state;
  record.lastSupervisionSteerAt = undefined;
  record.lastSupervisionAbortAt = undefined;
  let toolSequence = 0;
  return {
    onProgress: () => { state.lastProgressAt = Date.now(); },
    onToolActivity: (activity: ToolActivity) => {
      if (activity.type === "start") state.activeTools.set(String(++toolSequence), activity.toolName);
      if (activity.type === "end") {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        record.toolUses++;
      }
      if (activity.type === "diagnostic") {
        record.diagnostics ??= [];
        record.diagnostics.push(activity.toolName);
      }
      state.lastProgressAt = Date.now();
      callbacks.onToolActivity?.(activity);
    },
    onTextDelta: (delta: string, fullText: string) => {
      state.responseText = fullText;
      state.lastProgressAt = Date.now();
      callbacks.onTextDelta?.(delta, fullText);
    },
    onTurnEnd: (turnCount: number) => {
      record.turnCount = previousTurns + turnCount;
      state.lastProgressAt = Date.now();
      callbacks.onTurnEnd?.(turnCount);
    },
    onAssistantUsage: (usage: LifetimeUsage) => {
      addUsage(record.lifetimeUsage, usage);
      record.lifetimeCost = (record.lifetimeCost ?? 0) + (usage.cost ?? 0);
      state.lastProgressAt = Date.now();
      callbacks.onUsage?.(usage);
      callbacks.onAssistantUsage?.(usage);
    },
  };
}

/**
 * Start an Execution on the record, synchronously: running from now with no
 * prior outcome, and a fresh activity view. `run` then awaits the session
 * source, attaches the session (provisional label, pending steers), runs the
 * prompt, and settles: precedence stopped > aborted > error > force_steered >
 * completed, a stop's cause and time kept, and the final label.
 */
export function startExecution(record: ExecutionRecord, callbacks: ExecutionCallbacks = {}): Execution {
  record.status = "running";
  record.startedAt = Date.now();
  record.completedAt = undefined;
  record.result = undefined;
  record.error = undefined;
  record.structuredJson = undefined;
  record.structuredRetried = undefined;
  const activity = trackActivity(record, callbacks);
  let attached: AgentSession | undefined;

  const attach = (session: AgentSession) => {
    record.session = session;
    attached = session;
    labelExecution(record, session);
    // Flush any steers that arrived before the session was ready
    if (record.pendingSteers?.length) {
      for (const msg of record.pendingSteers) {
        session.steer(msg).catch(() => {});
      }
      record.pendingSteers = undefined;
    }
    callbacks.onSessionCreated?.(session);
  };

  const settle = (outcome: ExecutionOutcome) => {
    record.interruptionCause ??= outcome.interruptionCause;
    record.structuredJson = outcome.structuredJson;
    record.structuredRetried = outcome.structuredRetried;
    if (outcome.failure) record.error = outcome.failure;
    // A hard abort keeps "aborted"; then a failed final turn (provider error
    // that pi resolved instead of rejecting, #144) is an honest "error", not a
    // completion with an empty or stale result.
    if (record.status !== "stopped") {
      record.status = record.interruptionCause ? "aborted" : outcome.failure ? "error" : outcome.forceSteered ? "force_steered" : "completed";
    }
    record.result = outcome.text;
    if (attached) labelExecution(record, attached);
    record.completedAt ??= Date.now();
  };

  const fail = (error: unknown) => {
    if (record.status !== "stopped") record.status = "error";
    record.error = error instanceof Error ? error.message : String(error);
    if (attached) labelExecution(record, attached);
    record.completedAt ??= Date.now();
  };

  return {
    async run(source, prompt) {
      try {
        // A live session attaches synchronously; a source is awaited, then attached.
        const opened = typeof source === "function" ? await source({ onToolActivity: activity.onToolActivity }) : { session: source };
        attach(opened.session);
        settle(await execute(opened.session, (opened.promptPrefix ?? "") + prompt, {
          ...activity,
          signal: record.abortController?.signal,
          onCheckIn: callbacks.onCheckIn,
          onCompaction: callbacks.onCompaction,
        }));
      } catch (error) {
        fail(error);
      }
    },
  };
}

/** Stop a queued or running Execution at once; its Settlement keeps this cause and time. */
export function stopExecution(record: ExecutionRecord, cause: InterruptionCause): void {
  record.status = "stopped";
  record.completedAt = Date.now();
  record.interruptionCause = cause;
  record.abortController?.abort(cause);
}

/** Fail a start that threw before its Execution began. */
export function failExecutionStart(record: ExecutionRecord, error: unknown): void {
  record.status = "error";
  record.error = error instanceof Error ? error.message : String(error);
  record.completedAt = Date.now();
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession, onProgress?: ExecutionHooks["onProgress"]) {
  let text = "";
  let lastText = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // message_start also fires for user and toolResult messages — resetting on
    // those would wipe assistant text already collected. Reset only when a new
    // ASSISTANT message begins, so getText() is the last assistant message's text.
    if (event.type === "message_start" && event.message.role === "assistant") {
      if (text.trim()) lastText = text;
      text = "";
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if ((update.type === "thinking_delta" || update.type === "toolcall_delta") && update.delta.length > 0) {
        onProgress?.();
      }
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const completedText = extractText(event.message.content ?? []);
      if (completedText.trim()) lastText = completedText;
    }
  });
  return { getText: () => text.trim() ? text : lastText, unsubscribe };
}

/** Forward text deltas, tool activity, assistant usage, and compactions to the hooks. */
function forwardSessionEvents(session: AgentSession, hooks: ExecutionHooks): () => void {
  let currentMessageText = "";
  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      hooks.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      hooks.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      hooks.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = event.message.usage;
      if (u) hooks.onAssistantUsage?.({
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cost: u.cost?.total ?? 0,
      });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      hooks.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 * `startIndex` is the message count captured before the prompt, so the walk-back
 * never crosses into a previous turn: on a resume whose new turn failed empty,
 * this returns "" instead of the prior turn's answer (#144). Defaults to 0 (a
 * fresh spawn, where the whole history belongs to this run).
 */
function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed. Two failure shapes, both keyed off how the final turn STOPPED:
 *   - stopReason "error": a provider failure pi resolved instead of rejecting
 *     (any text; partial output is surfaced separately).
 *   - stopReason "length" with NO text: a silent max-token death — the run hit
 *     the output-token ceiling before writing anything, which would otherwise
 *     land as a "completed" run with an empty result (the #144 symptom).
 * Everything else completes: a clean "stop"/"toolUse" final, and — crucially — a
 * "length" stop that DID produce text (a legitimate truncated-but-useful answer).
 * "aborted" is handled by the manager's abort flag / "stopped" guard, not here.
 * Bounded by `startIndex` (like the text fallback) so a resume that produced no
 * assistant message of its own never inherits a PRIOR turn's stop reason.
 */
function finalTurnError(session: AgentSession, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

/** SDK cancellation alone proves no human action; bound detection to this execution. */
function finalInterruption(session: AgentSession, startIndex: number): InterruptionCause | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const message = session.messages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "aborted") return "unknown";
    return undefined;
  }
  return undefined;
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Run one Execution on an attached session: prompt it, await SDK idle even
 * after rejection or abort, and derive the outcome from this Execution's
 * messages only. Every Execution gets the hidden turn ceiling and a fresh
 * StructuredOutput failure budget on the session's remembered capture.
 */
export async function execute(session: AgentSession, prompt: string, hooks: ExecutionHooks = {}): Promise<ExecutionOutcome> {
  hooks.onSessionCreated?.(session);

  const turns = watchTurns(session, { onTurnEnd: hooks.onTurnEnd, onCheckIn: hooks.onCheckIn });
  let interruptionCause: InterruptionCause | undefined;

  const unsubEvents = forwardSessionEvents(session, hooks);
  const collector = collectResponseText(session, hooks.onProgress);
  const cleanupAbort = forwardAbortSignal(session, hooks.signal);

  // Boundary for the history fallback: only assistant text produced from here
  // on counts as this Execution's output (0 for a fresh session), so a failed
  // resume never surfaces the previous turn's answer (#144).
  const startLen = session.messages.length;
  const capture = takeStructuredCapture(session);
  if (capture) resetStructuredCapture(capture);
  let structuredRetried = false;
  let failure: string | undefined;
  try {
    if (hooks.signal?.aborted) interruptionCause = "unknown";
    else {
      await session.prompt(prompt);
      await session.waitForIdle();
      if (capture && !turns.interruptionCause && !hooks.signal?.aborted && !finalTurnError(session, startLen) && !finalInterruption(session, startLen)) {
        structuredRetried = await repairStructuredOutput(session, capture);
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    // A rejected prompt or an abort request does not prove SDK settlement.
    try {
      await session.waitForIdle();
    } finally {
      turns.unsubscribe();
      unsubEvents();
      collector.unsubscribe();
      cleanupAbort();
    }
  }

  const text = collector.getText().trim() || getLastAssistantText(session, startLen);
  interruptionCause ??= turns.interruptionCause ?? (hooks.signal?.aborted ? "unknown" : finalInterruption(session, startLen));
  return {
    text,
    interruptionCause,
    forceSteered: turns.forceSteered,
    failure: failure ?? finalTurnError(session, startLen) ?? structuredFailure(capture),
    structuredJson: capture?.json,
    structuredRetried,
  };
}
