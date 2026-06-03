import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pandaWarn", () => {
	it("emits the structured warn prefix and payload", async () => {
		const { pandaWarn } = await import("../warn.js");
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);

		pandaWarn("W001", { detail: "ok" });

		expect(console.warn).toHaveBeenCalledOnce();
		expect(console.warn).toHaveBeenCalledWith(
			"[panda-warn]",
			JSON.stringify({ code: "W001", ts: 1234567890, detail: "ok" }),
		);

		nowSpy.mockRestore();
	});
});

describe("pandaWarnOnce", () => {
	it("deduplicates repeated calls for the same key", async () => {
		const { pandaWarnOnce } = await import("../warn.js");
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);

		pandaWarnOnce("same-key", "W002", { detail: "one" });
		pandaWarnOnce("same-key", "W002", { detail: "two" });

		expect(console.warn).toHaveBeenCalledOnce();
		expect(console.warn).toHaveBeenCalledWith(
			"[panda-warn]",
			JSON.stringify({ code: "W002", ts: 1234567890, detail: "one" }),
		);

		nowSpy.mockRestore();
	});

	it("allows different keys to emit independently", async () => {
		const { pandaWarnOnce } = await import("../warn.js");
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);

		pandaWarnOnce("key-a", "W003", { which: "a" });
		pandaWarnOnce("key-b", "W004", { which: "b" });

		expect(console.warn).toHaveBeenCalledTimes(2);
		expect(console.warn).toHaveBeenNthCalledWith(
			1,
			"[panda-warn]",
			JSON.stringify({ code: "W003", ts: 1234567890, which: "a" }),
		);
		expect(console.warn).toHaveBeenNthCalledWith(
			2,
			"[panda-warn]",
			JSON.stringify({ code: "W004", ts: 1234567890, which: "b" }),
		);

		nowSpy.mockRestore();
	});
});
