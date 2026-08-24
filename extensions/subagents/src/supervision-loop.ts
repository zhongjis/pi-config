/**
 * supervision-loop.ts — Background-agent auto-supervision loop.
 *
 * A single `setInterval` tick that, every `BACKGROUND_SUPERVISION_INTERVAL_MS`,
 * asks the pure decision module ({@link getBackgroundSupervisionAction}) what to
 * do with each running background agent and performs the resulting steer/abort.
 *
 * The loop itself is deliberately thin: all policy lives in the pure module
 * (`background-supervision.ts`). This file only bridges the live manager +
 * per-agent activity state into that decision and applies its output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_SUPERVISION_INTERVAL_MS,
  emitSupervisionAbortWarning,
  emitSupervisionCeilingHitWarning,
  getBackgroundSupervisionAction,
  parseBackgroundSupervisionMode,
  parseSubagentSupervisionCeilingMs,
} from "./background-supervision.js";
import type { AgentRecord } from "./types.js";
import type { AgentActivity } from "./ui/agent-widget.js";

/** Steering text delivered when an idle background agent is auto-steered. */
export const AUTO_STEER_MESSAGE =
  "The agent was auto-steered to wrap up because it appears idle.";

/** Minimal manager surface the loop depends on (satisfied by AgentManager). */
export interface SupervisionManager {
  getRunning(): AgentRecord[];
  steer(id: string, message: string): boolean;
  abort(id: string): boolean;
}

export interface StartBackgroundSupervisionOptions {
  /** Override the poll cadence (ms). Defaults to BACKGROUND_SUPERVISION_INTERVAL_MS. */
  intervalMs?: number;
}

/**
 * Start the background-supervision loop. Returns a stop function that clears the
 * interval. Safe to call the stop function more than once.
 *
 * `pi` is accepted for wiring symmetry with the other lifecycle helpers; the
 * minimal loop does not need it (warnings route through the shared `pandaWarn`).
 */
export function startBackgroundSupervision(
  pi: ExtensionAPI,
  manager: SupervisionManager,
  agentActivity: Map<string, AgentActivity>,
  opts?: StartBackgroundSupervisionOptions,
): () => void {
  void pi;

  function tick(): void {
    const now = Date.now();
    const mode = parseBackgroundSupervisionMode();
    const ceilingMs = parseSubagentSupervisionCeilingMs();
    for (const record of manager.getRunning()) {
      const activity = agentActivity.get(record.id);
      const { action, idleMs, reasonClass } = getBackgroundSupervisionAction({
        record,
        activity,
        now,
        mode,
        ceilingMs,
      });
      if (action === "none") continue;

      if (action === "steer") {
        manager.steer(record.id, AUTO_STEER_MESSAGE);
        record.lastSupervisionSteerAt = now;
        continue;
      }

      // action === "abort"
      manager.abort(record.id);
      record.lastSupervisionAbortAt = now;
      if (reasonClass === "ceiling") {
        emitSupervisionCeilingHitWarning({ agentId: record.id, idleMs, ceilingMs });
      }
      emitSupervisionAbortWarning({
        agentId: record.id,
        idleMs,
        reasonClass: reasonClass ?? "token-idle",
      });
    }
  }

  const timer = setInterval(tick, opts?.intervalMs ?? BACKGROUND_SUPERVISION_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
