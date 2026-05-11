/**
 * Defer notifications until a safe UI moment (e.g., `turn_end`).
 *
 * Pattern: when an extension detects "fallback activated" mid-stream, it can't
 * call `ctx.ui.notify` directly — the UI is in the middle of streaming the
 * assistant response. Instead, queue the notification and flush it on
 * `turn_end`.
 *
 * Each notifier holds one queued notification at a time (most recent wins).
 * Call `drain(ctx)` from the `turn_end` handler to flush.
 *
 * No globals — caller instantiates per-extension.
 */

export type NotificationType = "info" | "warning" | "error";

export interface QueuedNotification {
	message: string;
	type: NotificationType;
}

export interface OnceNotifier {
	/** Queue a notification (overwrites any pending one). */
	queue(message: string, type?: NotificationType): void;
	/** Flush the queued notification via `ctx.ui.notify`. Returns true if a notification was delivered. */
	drain(ctx: { ui: { notify(msg: string, type: NotificationType): void } }): boolean;
	/** Discard any queued notification without delivering. */
	clear(): void;
	/** Whether there's currently a notification waiting to drain. */
	hasPending(): boolean;
}

export function createOnceNotifier(): OnceNotifier {
	let pending: QueuedNotification | null = null;

	return {
		queue(message: string, type: NotificationType = "info") {
			pending = { message, type };
		},
		drain(ctx) {
			if (!pending) return false;
			const { message, type } = pending;
			pending = null;
			ctx.ui.notify(message, type);
			return true;
		},
		clear() {
			pending = null;
		},
		hasPending() {
			return pending !== null;
		},
	};
}
