export const BACKGROUND_SUPERVISION_INTERVAL_MS = 30_000;
export const BACKGROUND_STALE_STEER_AFTER_MS = 2 * 60_000;
export const BACKGROUND_STALE_ABORT_AFTER_MS = 5 * 60_000;
export const BACKGROUND_SUPERVISION_COOLDOWN_MS = 2 * 60_000;

export type BackgroundSupervisionAction = "none" | "steer" | "abort";

type ActivitySnapshot = {
  lastProgressAt?: number;
};

type RecordSnapshot = {
  status: string;
  isBackground?: boolean;
  lastSupervisionSteerAt?: number;
  lastSupervisionAbortAt?: number;
  waitingConsumers?: number;
  startedAt: number;
};

export function getLastProgressAt(activity: ActivitySnapshot | undefined, startedAt: number): number {
  return activity?.lastProgressAt ?? startedAt;
}

export function getBackgroundSupervisionAction(args: {
  record: RecordSnapshot;
  activity?: ActivitySnapshot;
  now: number;
}): { action: BackgroundSupervisionAction; idleMs: number } {
  const { record, activity, now } = args;

  if (!record.isBackground || record.status !== "running") {
    return { action: "none", idleMs: 0 };
  }

  if ((record.waitingConsumers ?? 0) > 0) {
    return { action: "none", idleMs: 0 };
  }

  const idleMs = now - getLastProgressAt(activity, record.startedAt);

  if (idleMs >= BACKGROUND_STALE_ABORT_AFTER_MS && !record.lastSupervisionAbortAt) {
    return { action: "abort", idleMs };
  }

  const lastSteerAt = record.lastSupervisionSteerAt ?? 0;
  if (idleMs >= BACKGROUND_STALE_STEER_AFTER_MS && now - lastSteerAt >= BACKGROUND_SUPERVISION_COOLDOWN_MS) {
    return { action: "steer", idleMs };
  }

  return { action: "none", idleMs };
}
