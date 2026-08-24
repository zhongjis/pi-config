import { pandaWarn } from "../../lib/warn.js";
import {
  BACKGROUND_STALE_ABORT_AFTER_MS,
  BACKGROUND_STALE_STEER_AFTER_MS,
  BACKGROUND_SUPERVISION_COOLDOWN_MS,
  BACKGROUND_SUPERVISION_INTERVAL_MS,
  DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS,
} from "./constants.js";

export {
  BACKGROUND_STALE_ABORT_AFTER_MS,
  BACKGROUND_STALE_STEER_AFTER_MS,
  BACKGROUND_SUPERVISION_COOLDOWN_MS,
  BACKGROUND_SUPERVISION_INTERVAL_MS,
  DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS,
};

export type BackgroundSupervisionAction = "none" | "steer" | "abort";
export type BackgroundSupervisionMode = "legacy" | "v2";
export type BackgroundSupervisionReasonClass = "token-idle" | "ceiling" | "non-stream-disabled";

type ActivitySnapshot = {
  lastProgressAt?: number;
  activeTools?: { size: number };
  streamingDeltasSeen?: boolean;
  nonStreamingSince?: number;
};

type RecordSnapshot = {
  status: string;
  isBackground?: boolean;
  lastSupervisionSteerAt?: number;
  lastSupervisionAbortAt?: number;
  waitingConsumers?: number;
  startedAt: number;
};

export function parseBackgroundSupervisionMode(value = process.env.PI_SUBAGENT_SUPERVISION): BackgroundSupervisionMode {
  return value === "legacy" ? "legacy" : "v2";
}

export function parseSubagentSupervisionCeilingMs(value = process.env.SUBAGENT_SUPERVISION_CEILING_MS): number {
  if (value == null || value.trim() === "") return DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS;
  return Math.floor(parsed);
}

export function getLastProgressAt(activity: ActivitySnapshot | undefined, startedAt: number): number {
  return activity?.lastProgressAt ?? startedAt;
}

export function emitSupervisionAbortWarning(args: {
  agentId: string;
  idleMs: number;
  reasonClass: BackgroundSupervisionReasonClass;
}): void {
  pandaWarn("subagent.supervision.abort", {
    agentId: args.agentId,
    idleMs: args.idleMs,
    reasonClass: args.reasonClass,
  });
}

export function emitSupervisionCeilingHitWarning(args: {
  agentId: string;
  idleMs: number;
  ceilingMs: number;
}): void {
  pandaWarn("subagent.supervision.ceiling-hit", {
    agentId: args.agentId,
    idleMs: args.idleMs,
    ceilingMs: args.ceilingMs,
  });
}

export function getBackgroundSupervisionAction(args: {
  record: RecordSnapshot;
  activity?: ActivitySnapshot;
  now: number;
  mode?: BackgroundSupervisionMode;
  ceilingMs?: number;
  /** When true (foreground supervised wait), skip the waitingConsumers deferral — the waiter IS supervising. */
  ignoreWaiters?: boolean;
}): { action: BackgroundSupervisionAction; idleMs: number; reasonClass?: BackgroundSupervisionReasonClass; markNonStreaming?: boolean } {
  const { record, activity, now, mode = "v2", ceilingMs = DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS, ignoreWaiters = false } = args;

  if (!record.isBackground || record.status !== "running") {
    return { action: "none", idleMs: 0 };
  }

  const runtimeMs = now - record.startedAt;
  if (runtimeMs >= ceilingMs && !record.lastSupervisionAbortAt) {
    return { action: "abort", idleMs: runtimeMs, reasonClass: "ceiling" };
  }

  if (!ignoreWaiters && (record.waitingConsumers ?? 0) > 0) {
    return { action: "none", idleMs: 0 };
  }

  const idleMs = now - getLastProgressAt(activity, record.startedAt);

  if (mode === "v2" && activity?.activeTools && activity.activeTools.size > 0) {
    return { action: "none", idleMs };
  }

  if (mode === "legacy") {
    if (idleMs >= BACKGROUND_STALE_ABORT_AFTER_MS && !record.lastSupervisionAbortAt) {
      return { action: "abort", idleMs };
    }

    const lastSteerAt = record.lastSupervisionSteerAt ?? 0;
    if (idleMs >= BACKGROUND_STALE_STEER_AFTER_MS && now - lastSteerAt >= BACKGROUND_SUPERVISION_COOLDOWN_MS) {
      return { action: "steer", idleMs };
    }

    return { action: "none", idleMs };
  }

  const lastSteerAt = record.lastSupervisionSteerAt ?? 0;
  if (idleMs >= BACKGROUND_STALE_STEER_AFTER_MS && now - lastSteerAt >= BACKGROUND_SUPERVISION_COOLDOWN_MS) {
    return { action: "steer", idleMs };
  }

  if (idleMs >= BACKGROUND_STALE_ABORT_AFTER_MS && !record.lastSupervisionAbortAt) {
    if (activity?.streamingDeltasSeen === false) {
      return { action: "none", idleMs, reasonClass: "non-stream-disabled", markNonStreaming: true };
    }
    return { action: "abort", idleMs };
  }

  return { action: "none", idleMs };
}
