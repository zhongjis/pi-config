/**
 * Generic two-tier failover stream wrapper.
 *
 * Wraps a primary stream function; on specific error conditions (detected via
 * caller-provided `isFailure`), transparently rotates to a fallback stream.
 *
 * Design: pure function, no internal state. Caller owns all mutable state
 * (fallback-active flag, cache, notifier). This lib fn only orchestrates the
 * event flow: try primary, detect failure before first content, flush buffered
 * `start` event, hand off to fallback, patch model IDs on emitted events.
 *
 * Usage — see extensions/clauderock.
 */

import {
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

/**
 * Minimal event stream shape emitted by `createAssistantMessageEventStream`.
 * Kept narrow so tests can construct fakes without importing pi-ai internals.
 */
export interface EventSink {
	push(event: unknown): void;
	end(): void;
}

/** A stream function: consumes model+context+options, yields events. */
export type StreamFn = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => AsyncIterable<any>;

export interface StreamWithFallbackOptions {
	/** The model as pi sees it (used for event patching + identity preservation). */
	model: Model<any>;
	context: Context;
	options?: SimpleStreamOptions;

	/**
	 * Stream from the primary provider. Typically wraps `streamSimpleAnthropic`,
	 * `streamSimple`, or a provider-specific function.
	 */
	tryPrimary: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AsyncIterable<any>;

	/**
	 * Stream from the fallback provider. Called when primary fails with a
	 * condition matching `isFailure`, or when `shouldSkipPrimary()` returns true.
	 * Receives the ORIGINAL model (pi's view); the fallback fn is responsible
	 * for any provider translation (id rewriting, baseUrl swap, etc.).
	 */
	tryFallback: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AsyncIterable<any>;

	/** Return true if the error/event indicates primary should failover. */
	isFailure: (errOrEvent: unknown) => boolean;

	/**
	 * If true, skip primary entirely and stream from fallback. Lets callers
	 * implement "sticky" fallback state across turns without re-hitting the
	 * primary provider (which would waste quota on a known-exhausted endpoint).
	 */
	shouldSkipPrimary?: () => boolean;

	/**
	 * Called when fallback activates for the first time in the current stream.
	 * Receives the reason text (error message). Caller uses this to update
	 * persistent state (cache, notifier). Not called when `shouldSkipPrimary`
	 * was already true.
	 */
	onFallbackActivated?: (reason: string) => void;

	/**
	 * Called when `shouldSkipPrimary` returned true and fallback is streaming.
	 * Lets callers queue an "already exhausted, using cached fallback" notice.
	 */
	onCachedFallback?: () => void;

	/**
	 * Post-process events from the fallback stream before forwarding. Typical
	 * use: rewrite `event.model` / `event.message.model` so pi state never
	 * sees the fallback provider's model ID.
	 */
	patchFallbackEvent?: (event: any) => any;

	/** Preserve the `start` event for fallback path (most callers want true). */
	buffersStartEvent?: boolean;
}

/**
 * Patch a stream event's model fields so pi sees a consistent model identity
 * regardless of which provider actually served the request.
 *
 * Walks the event and rewrites any top-level `model` string plus `model`
 * fields inside `partial`, `message`, and `error` payloads. Non-destructive
 * — returns a new object only if changes were needed.
 */
export function patchEventModelId<T>(event: T, modelId: string): T {
	if (!event || typeof event !== "object") return event;
	const original = event as Record<string, unknown>;
	let patched: Record<string, unknown> | null = null;
	const ensurePatched = () => (patched ??= { ...original });

	if (typeof original.model === "string" && original.model !== modelId) {
		ensurePatched().model = modelId;
	}

	for (const key of ["partial", "message", "error"] as const) {
		const nested = original[key];
		if (nested && typeof nested === "object" && "model" in (nested as Record<string, unknown>)) {
			const n = nested as Record<string, unknown>;
			if (typeof n.model === "string" && n.model !== modelId) {
				ensurePatched()[key] = { ...n, model: modelId };
			}
		}
	}

	return (patched ?? original) as T;
}

function extractErrorReason(event: any): string {
	const err = event?.error ?? event;
	if (err && typeof err === "object") {
		if (typeof err.errorMessage === "string") return err.errorMessage;
		if (typeof err.message === "string") return err.message;
	}
	return "quota exhausted";
}

async function pipeFallback(
	stream: EventSink,
	fallbackIter: AsyncIterable<any>,
	patchFn: ((event: any) => any) | undefined,
	startAlreadyPushed: boolean,
): Promise<void> {
	for await (const event of fallbackIter) {
		const out = patchFn ? patchFn(event) : event;
		if (out?.type === "start" && startAlreadyPushed) continue;
		stream.push(out);
	}
}

/**
 * Run primary→fallback orchestration on a fresh event stream.
 *
 * Returns the stream synchronously; the async work is attached as a detached
 * promise (matches clauderock's existing contract and pi-ai's expectation
 * that `streamSimple` is sync-to-construct, async-to-iterate).
 */
export function streamWithFallback(opts: StreamWithFallbackOptions): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	const buffersStart = opts.buffersStartEvent ?? true;

	(async () => {
		try {
			// Fast path: caller already knows fallback should be used.
			if (opts.shouldSkipPrimary?.()) {
				opts.onCachedFallback?.();
				await pipeFallback(
					stream as unknown as EventSink,
					opts.tryFallback(opts.model, opts.context, opts.options),
					opts.patchFallbackEvent,
					false,
				);
				stream.end();
				return;
			}

			// Normal path: try primary. On failure BEFORE first content, rotate.
			let hasResponseContent = false;
			let pendingStart: any = null;

			try {
				const primaryIter = opts.tryPrimary(opts.model, opts.context, opts.options);
				for await (const event of primaryIter) {
					// Buffer start so fallback can avoid a duplicate
					if (buffersStart && event?.type === "start") {
						pendingStart = event;
						continue;
					}

					// Failure-before-content → rotate
					if (
						event?.type === "error"
						&& !hasResponseContent
						&& opts.isFailure(event?.error ?? event)
					) {
						const reason = extractErrorReason(event);
						opts.onFallbackActivated?.(reason);
						const hadStart = !!pendingStart;
						if (pendingStart) {
							stream.push(pendingStart);
							pendingStart = null;
						}
						await pipeFallback(
							stream as unknown as EventSink,
							opts.tryFallback(opts.model, opts.context, opts.options),
							opts.patchFallbackEvent,
							hadStart,
						);
						stream.end();
						return;
					}

					// Flush pendingStart on first non-start, non-failure event
					if (pendingStart) {
						stream.push(pendingStart);
						pendingStart = null;
					}
					hasResponseContent = true;
					stream.push(event);
				}

				// Primary completed; flush any pending start (edge case: empty stream)
				if (pendingStart) stream.push(pendingStart);
				stream.end();
			} catch (err) {
				// Thrown failure-before-content → rotate. Otherwise forward.
				if (opts.isFailure(err) && !hasResponseContent) {
					const reason = err instanceof Error ? err.message : "quota exhausted";
					opts.onFallbackActivated?.(reason);
					const hadStart = !!pendingStart;
					if (pendingStart) {
						stream.push(pendingStart);
						pendingStart = null;
					}
					await pipeFallback(
						stream as unknown as EventSink,
						opts.tryFallback(opts.model, opts.context, opts.options),
						opts.patchFallbackEvent,
						hadStart,
					);
					stream.end();
					return;
				}
				if (pendingStart) stream.push(pendingStart);
				stream.push({ type: "error", reason: "error", error: err });
				stream.end();
			}
		} catch (fatal) {
			stream.push({ type: "error", reason: "error", error: fatal });
			stream.end();
		}
	})().catch((fatal) => {
		stream.push({ type: "error", reason: "error", error: fatal });
		stream.end();
	});

	return stream;
}
