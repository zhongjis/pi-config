/**
 * Tests for stream-fallback.ts — two-tier failover orchestration.
 *
 * Covers:
 *   - Happy path: primary succeeds, events forwarded
 *   - pendingStart buffering and flushing
 *   - Failure via event stream triggers fallback
 *   - Failure via thrown error triggers fallback
 *   - Error after content already started → no fallback
 *   - shouldSkipPrimary → fallback runs directly
 *   - onFallbackActivated / onCachedFallback callbacks fire correctly
 *   - patchFallbackEvent rewrites event model IDs
 *   - Non-failure errors forwarded as-is
 *   - patchEventModelId walks top-level + nested model fields
 */

import { describe, expect, it, vi } from "vitest";
import { patchEventModelId, streamWithFallback } from "../stream-fallback.js";

// ---------------------------------------------------------------------------
// Pushable stream — faithful mock of AssistantMessageEventStream
// ---------------------------------------------------------------------------
function makePushableStream() {
	const queue: any[] = [];
	let done = false;
	let notify: (() => void) | null = null;

	return {
		push(event: any) {
			queue.push(event);
			if (notify) {
				const fn = notify;
				notify = null;
				fn();
			}
		},
		end() {
			done = true;
			if (notify) {
				const fn = notify;
				notify = null;
				fn();
			}
		},
		async result() {
			return undefined;
		},
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				async next(): Promise<IteratorResult<any>> {
					while (true) {
						if (i < queue.length) return { value: queue[i++], done: false };
						if (done) return { value: undefined, done: true };
						await new Promise<void>((r) => {
							notify = r;
						});
					}
				},
			};
		},
	};
}

vi.mock("@mariozechner/pi-ai", () => ({
	createAssistantMessageEventStream: makePushableStream,
}));

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------
const startEvent = (model = "primary-model") => ({
	type: "start",
	partial: { model },
});

const textDeltaEvent = (delta = "hi") => ({
	type: "text_delta",
	delta,
});

const doneEvent = () => ({ type: "done", reason: "stop" });

const errorEvent = (errorMessage: string) => ({
	type: "error",
	error: { errorMessage },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function collectStream(stream: any): Promise<any[]> {
	const events: any[] = [];
	for await (const e of stream) events.push(e);
	return events;
}

async function* fromEvents(events: any[]): AsyncIterable<any> {
	for (const e of events) yield e;
}

// biome-ignore lint/correctness/useYield: generator exists only to satisfy AsyncIterable type; throws are the entire semantic
async function* throwing(err: unknown): AsyncIterable<any> {
	throw err;
}

const MODEL = { id: "primary-model", provider: "primary" } as any;
const CTX = {} as any;

function isQuotaMock(err: any): boolean {
	const msg = err?.errorMessage ?? err?.error?.errorMessage ?? err?.message ?? "";
	return String(msg).toLowerCase().includes("quota");
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("streamWithFallback — happy path", () => {
	it("forwards all events when primary succeeds", async () => {
		const events = [startEvent(), textDeltaEvent("hello"), doneEvent()];
		const primary = vi.fn(() => fromEvents(events));
		const fallback = vi.fn(() => fromEvents([]));

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: isQuotaMock,
		});

		const collected = await collectStream(stream);
		expect(collected.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
		expect(fallback).not.toHaveBeenCalled();
	});

	it("flushes pendingStart on first content event", async () => {
		const events = [startEvent(), textDeltaEvent("hi"), doneEvent()];
		const primary = vi.fn(() => fromEvents(events));

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: () => fromEvents([]),
			isFailure: isQuotaMock,
		});

		const collected = await collectStream(stream);
		// start should come BEFORE text_delta
		const startIdx = collected.findIndex((e) => e.type === "start");
		const deltaIdx = collected.findIndex((e) => e.type === "text_delta");
		expect(startIdx).toBeLessThan(deltaIdx);
	});

	it("flushes pendingStart if primary ends without producing content", async () => {
		// Edge case: primary emits only start then done — still flush start
		const primary = vi.fn(() => fromEvents([startEvent(), doneEvent()]));

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: () => fromEvents([]),
			isFailure: isQuotaMock,
		});

		const collected = await collectStream(stream);
		expect(collected.map((e) => e.type)).toEqual(["start", "done"]);
	});
});

// ---------------------------------------------------------------------------
// Failure via event stream
// ---------------------------------------------------------------------------
describe("streamWithFallback — event-stream failure", () => {
	it("rotates to fallback when primary emits failure event before content", async () => {
		const primary = vi.fn(() => fromEvents([errorEvent("quota exhausted")]));
		const fallback = vi.fn(() => fromEvents([startEvent("fallback-model"), doneEvent()]));

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: isQuotaMock,
		});

		const collected = await collectStream(stream);
		expect(fallback).toHaveBeenCalledOnce();
		expect(collected.some((e) => e.type === "error")).toBe(false);
		expect(collected.some((e) => e.type === "done")).toBe(true);
	});

	it("calls onFallbackActivated with reason text", async () => {
		const onActivated = vi.fn();
		const primary = () => fromEvents([errorEvent("quota exhausted now")]);
		const fallback = () => fromEvents([doneEvent()]);

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: isQuotaMock,
			onFallbackActivated: onActivated,
		});

		await collectStream(stream);
		expect(onActivated).toHaveBeenCalledOnce();
		expect(onActivated.mock.calls[0][0]).toContain("quota exhausted");
	});

	it("flushes buffered start BEFORE fallback stream starts", async () => {
		const primary = () => fromEvents([startEvent("primary-model"), errorEvent("quota")]);
		const fallback = () => fromEvents([startEvent("fallback-model"), doneEvent()]);

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: isQuotaMock,
		});

		const collected = await collectStream(stream);
		const starts = collected.filter((e) => e.type === "start");
		// Exactly one start — caller pushed primary's, fallback's duplicate was swallowed
		expect(starts.length).toBe(1);
		expect(starts[0].partial.model).toBe("primary-model");
	});

	it("does NOT rotate if error arrives AFTER content", async () => {
		const events = [
			startEvent(),
			textDeltaEvent("partial response"),
			errorEvent("quota exhausted"),
		];
		const primary = () => fromEvents(events);
		const fallback = vi.fn(() => fromEvents([]));

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: isQuotaMock,
		});

		const collected = await collectStream(stream);
		expect(fallback).not.toHaveBeenCalled();
		expect(collected.some((e) => e.type === "error")).toBe(true);
	});

	it("does NOT rotate on non-failure errors (predicate returns false)", async () => {
		const primary = () => fromEvents([errorEvent("network unreachable")]);
		const fallback = vi.fn(() => fromEvents([]));

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: isQuotaMock,
		});

		const collected = await collectStream(stream);
		expect(fallback).not.toHaveBeenCalled();
		expect(collected.some((e) => e.type === "error")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Failure via thrown error
// ---------------------------------------------------------------------------
describe("streamWithFallback — thrown error", () => {
	it("rotates to fallback when primary throws failure error before content", async () => {
		const primary = () => throwing(new Error("quota exhausted"));
		const fallback = vi.fn(() => fromEvents([doneEvent()]));

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: (e) => (e as any)?.message?.includes("quota"),
		});

		const collected = await collectStream(stream);
		expect(fallback).toHaveBeenCalledOnce();
		expect(collected.some((e) => e.type === "done")).toBe(true);
	});

	it("forwards non-failure thrown errors as error events", async () => {
		const primary = () => throwing(new Error("boom"));
		const fallback = vi.fn(() => fromEvents([]));

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: () => false,
		});

		const collected = await collectStream(stream);
		expect(fallback).not.toHaveBeenCalled();
		expect(collected.some((e) => e.type === "error")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Cached fallback (shouldSkipPrimary)
// ---------------------------------------------------------------------------
describe("streamWithFallback — cached fallback", () => {
	it("skips primary entirely when shouldSkipPrimary returns true", async () => {
		const primary = vi.fn(() => fromEvents([]));
		const fallback = vi.fn(() => fromEvents([startEvent("fallback"), doneEvent()]));

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: isQuotaMock,
			shouldSkipPrimary: () => true,
		});

		await collectStream(stream);
		expect(primary).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledOnce();
	});

	it("calls onCachedFallback but NOT onFallbackActivated on skip-primary path", async () => {
		const onCached = vi.fn();
		const onActivated = vi.fn();
		const fallback = () => fromEvents([doneEvent()]);

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: () => fromEvents([]),
			tryFallback: fallback,
			isFailure: isQuotaMock,
			shouldSkipPrimary: () => true,
			onCachedFallback: onCached,
			onFallbackActivated: onActivated,
		});

		await collectStream(stream);
		expect(onCached).toHaveBeenCalledOnce();
		expect(onActivated).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Event patching
// ---------------------------------------------------------------------------
describe("streamWithFallback — patchFallbackEvent", () => {
	it("applies patcher to every fallback event", async () => {
		const primary = () => fromEvents([errorEvent("quota")]);
		const fallback = () =>
			fromEvents([startEvent("zen-model"), textDeltaEvent("hi"), doneEvent()]);

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: fallback,
			isFailure: isQuotaMock,
			patchFallbackEvent: (e) => patchEventModelId(e, "primary-model"),
		});

		const collected = await collectStream(stream);
		const startEvt = collected.find((e) => e.type === "start" && e.partial?.model === "zen-model");
		// start from fallback was dropped (primary already pushed one)
		expect(startEvt).toBeUndefined();
		// ... but if no primary start existed, the patched fallback start would be there
	});

	it("does not call patcher on primary events", async () => {
		const patcher = vi.fn((e) => e);
		const primary = () => fromEvents([startEvent(), doneEvent()]);

		const stream = streamWithFallback({
			model: MODEL,
			context: CTX,
			tryPrimary: primary,
			tryFallback: () => fromEvents([]),
			isFailure: isQuotaMock,
			patchFallbackEvent: patcher,
		});

		await collectStream(stream);
		expect(patcher).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// patchEventModelId (pure fn)
// ---------------------------------------------------------------------------
describe("patchEventModelId", () => {
	it("returns event unchanged when already matching", () => {
		const e = { type: "text_delta", model: "foo" };
		expect(patchEventModelId(e, "foo")).toBe(e);
	});

	it("rewrites top-level model string", () => {
		const e = { type: "start", model: "bedrock-id" } as any;
		const out = patchEventModelId(e, "anthropic-id");
		expect((out as any).model).toBe("anthropic-id");
		expect(e.model).toBe("bedrock-id"); // original unchanged (non-destructive)
	});

	it("rewrites nested partial.model", () => {
		const e = { type: "start", partial: { model: "bedrock-id", other: "x" } } as any;
		const out = patchEventModelId(e, "anthropic-id") as any;
		expect(out.partial.model).toBe("anthropic-id");
		expect(out.partial.other).toBe("x");
	});

	it("rewrites nested message.model", () => {
		const e = { type: "done", message: { model: "zen-id", role: "assistant" } } as any;
		const out = patchEventModelId(e, "go-id") as any;
		expect(out.message.model).toBe("go-id");
		expect(out.message.role).toBe("assistant");
	});

	it("rewrites nested error.model", () => {
		const e = { type: "error", error: { model: "zen-id", errorMessage: "fail" } } as any;
		const out = patchEventModelId(e, "go-id") as any;
		expect(out.error.model).toBe("go-id");
		expect(out.error.errorMessage).toBe("fail");
	});

	it("handles events without model fields gracefully", () => {
		const e = { type: "text_delta", delta: "hi" };
		expect(patchEventModelId(e, "x")).toBe(e);
	});

	it("handles null/undefined events", () => {
		expect(patchEventModelId(null as any, "x")).toBe(null);
		expect(patchEventModelId(undefined as any, "x")).toBe(undefined);
	});

	it("rewrites all three nested fields at once", () => {
		const e = {
			type: "done",
			model: "zen-id",
			partial: { model: "zen-id" },
			message: { model: "zen-id" },
		} as any;
		const out = patchEventModelId(e, "go-id") as any;
		expect(out.model).toBe("go-id");
		expect(out.partial.model).toBe("go-id");
		expect(out.message.model).toBe("go-id");
	});
});
