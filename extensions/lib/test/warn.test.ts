import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("installPandaWarnFileSink", () => {
	it("writes [panda-warn] lines to <dir>/panda-warn.log instead of the console", async () => {
		const { pandaWarn, installPandaWarnFileSink } = await import("../warn.js");
		const dir = mkdtempSync(join(tmpdir(), "panda-warn-test-"));
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);

		try {
			installPandaWarnFileSink(() => dir);
			pandaWarn("W100", { detail: "to-file" });

			expect(console.warn).not.toHaveBeenCalled();
			const contents = readFileSync(join(dir, "panda-warn.log"), "utf-8");
			expect(contents).toBe(
				`[panda-warn] ${JSON.stringify({ code: "W100", ts: 1234567890, detail: "to-file" })}\n`,
			);
		} finally {
			nowSpy.mockRestore();
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("is idempotent — a second install call is ignored", async () => {
		const { pandaWarn, installPandaWarnFileSink } = await import("../warn.js");
		const dirA = mkdtempSync(join(tmpdir(), "panda-warn-a-"));
		const dirB = mkdtempSync(join(tmpdir(), "panda-warn-b-"));

		try {
			installPandaWarnFileSink(() => dirA);
			installPandaWarnFileSink(() => dirB); // ignored — already installed
			pandaWarn("W101");

			expect(existsSync(join(dirA, "panda-warn.log"))).toBe(true);
			expect(existsSync(join(dirB, "panda-warn.log"))).toBe(false);
		} finally {
			rmSync(dirA, { force: true, recursive: true });
			rmSync(dirB, { force: true, recursive: true });
		}
	});

	it("resetPandaWarnSink restores console output after a file sink is installed", async () => {
		const { pandaWarn, installPandaWarnFileSink, resetPandaWarnSink } = await import("../warn.js");
		const dir = mkdtempSync(join(tmpdir(), "panda-warn-reset-"));

		try {
			installPandaWarnFileSink(() => dir);
			resetPandaWarnSink();
			pandaWarn("W102");

			expect(console.warn).toHaveBeenCalledWith("[panda-warn]", expect.stringContaining("W102"));
			expect(existsSync(join(dir, "panda-warn.log"))).toBe(false);
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});
