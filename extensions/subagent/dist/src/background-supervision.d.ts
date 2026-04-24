export declare const BACKGROUND_SUPERVISION_INTERVAL_MS = 30000;
export declare const BACKGROUND_STALE_STEER_AFTER_MS: number;
export declare const BACKGROUND_STALE_ABORT_AFTER_MS: number;
export declare const BACKGROUND_SUPERVISION_COOLDOWN_MS: number;
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
export declare function getLastProgressAt(activity: ActivitySnapshot | undefined, startedAt: number): number;
export declare function getBackgroundSupervisionAction(args: {
    record: RecordSnapshot;
    activity?: ActivitySnapshot;
    now: number;
}): {
    action: BackgroundSupervisionAction;
    idleMs: number;
};
export {};
