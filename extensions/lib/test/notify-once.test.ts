import { describe, expect, it, vi } from "vitest";
import { createOnceNotifier } from "../notify-once.js";

function makeCtx() {
	const notifyFn = vi.fn();
	return {
		ctx: { ui: { notify: notifyFn } },
		notifyFn,
	};
}

describe("createOnceNotifier", () => {
	it("initially has no pending notification", () => {
		const n = createOnceNotifier();
		expect(n.hasPending()).toBe(false);
	});

	it("queue() sets pending", () => {
		const n = createOnceNotifier();
		n.queue("hello");
		expect(n.hasPending()).toBe(true);
	});

	it("drain() delivers the queued notification and returns true", () => {
		const { ctx, notifyFn } = makeCtx();
		const n = createOnceNotifier();
		n.queue("hello", "warning");

		const delivered = n.drain(ctx);
		expect(delivered).toBe(true);
		expect(notifyFn).toHaveBeenCalledWith("hello", "warning");
		expect(n.hasPending()).toBe(false);
	});

	it("drain() returns false when nothing queued", () => {
		const { ctx, notifyFn } = makeCtx();
		const n = createOnceNotifier();
		expect(n.drain(ctx)).toBe(false);
		expect(notifyFn).not.toHaveBeenCalled();
	});

	it("queue() overwrites previous pending notification (latest wins)", () => {
		const { ctx, notifyFn } = makeCtx();
		const n = createOnceNotifier();
		n.queue("first");
		n.queue("second", "error");

		n.drain(ctx);
		expect(notifyFn).toHaveBeenCalledOnce();
		expect(notifyFn).toHaveBeenCalledWith("second", "error");
	});

	it("clear() discards without delivering", () => {
		const { ctx, notifyFn } = makeCtx();
		const n = createOnceNotifier();
		n.queue("will be cleared");
		n.clear();
		expect(n.hasPending()).toBe(false);

		n.drain(ctx);
		expect(notifyFn).not.toHaveBeenCalled();
	});

	it("drain twice delivers only once", () => {
		const { ctx, notifyFn } = makeCtx();
		const n = createOnceNotifier();
		n.queue("once");
		n.drain(ctx);
		n.drain(ctx);
		expect(notifyFn).toHaveBeenCalledOnce();
	});

	it("defaults type to 'info'", () => {
		const { ctx, notifyFn } = makeCtx();
		const n = createOnceNotifier();
		n.queue("no type");
		n.drain(ctx);
		expect(notifyFn).toHaveBeenCalledWith("no type", "info");
	});
});
