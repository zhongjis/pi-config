/**
 * turn-ceiling.ts — Hidden per-Execution turn ceiling: a safety net for harness
 * bugs, far above the turns a working subagent needs. Below it, the orchestrator
 * check-in asks the orchestrator to check a long-running Execution.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { InterruptionCause } from "./types.js";

export const TURN_CEILING = 300;
/** Unfinished turns allowed after the wrap-up reminder before the abort. */
export const TURN_CEILING_GRACE = 5;
export const TURN_CEILING_REMINDER = "You've been working on this for a while. Please wrap up now and give your final answer with what you have.";
/** Turns after which the orchestrator is told to check an orchestrator-owned Execution. */
export const TURN_CHECK_IN = 150;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** `SUBAGENT_TURN_CEILING` override; anything but a positive integer falls back to the default. */
export function parseTurnCeiling(value = process.env.SUBAGENT_TURN_CEILING): number {
  return positiveInteger(value, TURN_CEILING);
}

/** `SUBAGENT_TURN_CHECK_IN` override; anything but a positive integer falls back to the default. */
export function parseTurnCheckIn(value = process.env.SUBAGENT_TURN_CHECK_IN): number {
  return positiveInteger(value, TURN_CHECK_IN);
}

/** The orchestrator's check-in notice; `converted` leads with the foreground-to-background conversion. */
export function turnCheckInNotice(record: { id: string; description: string }, threshold: number, converted = false): string {
  const lead = converted
    ? `Agent "${record.description}" (${record.id}) has used ${threshold} turns; it has been automatically converted to a background agent.`
    : `Agent "${record.description}" (${record.id}) has used ${threshold} turns and is still running.`;
  return `${lead} Check that it is behaving: it stays on the task you gave it, every few turns produce new progress, and it is moving toward a final answer. Read its transcript with get_agent_result (verbose: true). If it is behaving, let it continue and collect it later with get_agent_result (wait: true). If it is looping, drifting, or sprawling, steer it with steer_subagent to wrap up or change course. If the task is too large for one agent, split similar work into smaller tasks next time.`;
}

export interface TurnWatchOptions {
  /** Called at the end of each turn with this Execution's cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once, with the check-in threshold, when an unfinished turn reaches it. */
  onCheckIn?: (threshold: number) => void;
}

export interface TurnWatch {
  /** The Execution got the wrap-up reminder. */
  readonly forceSteered: boolean;
  /** `turn-limit` once the grace turns ran out and the session was aborted. */
  readonly interruptionCause: InterruptionCause | undefined;
  unsubscribe(): void;
}

/**
 * Count one Execution's turns and enforce the ceiling (read at start). Only an
 * unfinished turn — a tool-use turn that did not end with every tool terminating —
 * fires the check-in (read at start) once, and gets the reminder at the ceiling
 * and the abort after the grace turns.
 */
export function watchTurns(session: AgentSession, options: TurnWatchOptions = {}): TurnWatch {
  const ceiling = parseTurnCeiling();
  const checkIn = parseTurnCheckIn();
  let checkedIn = false;
  let turnCount = 0;
  let completedTools = 0;
  let allToolsTerminate = true;
  let forceSteered = false;
  let interruptionCause: InterruptionCause | undefined;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_end") {
      completedTools++;
      allToolsTerminate = allToolsTerminate && event.result?.terminate === true;
    }
    if (event.type !== "turn_end") return;
    turnCount++;
    options.onTurnEnd?.(turnCount);
    const unfinished = event.message.role === "assistant"
      && event.message.stopReason !== "error" && event.message.stopReason !== "aborted"
      && event.message.content.some((block) => block.type === "toolCall")
      && !(completedTools > 0 && allToolsTerminate);
    completedTools = 0;
    allToolsTerminate = true;
    if (!unfinished) return;
    if (!checkedIn && turnCount >= checkIn) {
      checkedIn = true;
      options.onCheckIn?.(checkIn);
    }
    if (!forceSteered && turnCount >= ceiling) {
      forceSteered = true;
      session.steer(TURN_CEILING_REMINDER);
    } else if (forceSteered && turnCount >= ceiling + TURN_CEILING_GRACE) {
      interruptionCause = "turn-limit";
      session.abort();
    }
  });
  return {
    get forceSteered() { return forceSteered; },
    get interruptionCause() { return interruptionCause; },
    unsubscribe,
  };
}
