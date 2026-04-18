import { describe, it, expect, beforeEach } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { createMockContext } from "../../../test/fixtures/mock-context.js";

type InputResult =
	| { action: "continue" }
	| { action: "transform"; text: string }
	| { action: "handled" }
	| undefined;

/**
 * Helper: call the extension's input handler directly and return result.
 * mock-pi stores lifecycle handlers by event name; we grab the "input" handler.
 */
async function fireInput(
	mock: ReturnType<typeof createMockPi>,
	text: string,
	ctx?: ReturnType<typeof createMockContext>,
): Promise<InputResult> {
	const handlers = mock.lifecycleHandlers.get("input") ?? [];
	expect(handlers.length).toBeGreaterThan(0);
	const handler = handlers[0];
	return (await handler({ text }, ctx ?? createMockContext())) as InputResult;
}

/** Create a mock context whose sessionManager.getEntries returns custom mode entries. */
function createCtxWithMode(mode: string) {
	const ctx = createMockContext();
	(ctx.sessionManager as any).getEntries = () => [
		{ type: "custom", customType: "agent-mode", data: { mode } },
	];
	return ctx;
}

describe("ulw extension — unit tests", () => {
	let mock: ReturnType<typeof createMockPi>;

	beforeEach(async () => {
		mock = createMockPi();
		const mod = await import("../index.js");
		mod.default(mock.pi as never);
	});

	// ── Registration ────────────────────────────────────────────

	it("registers an input handler", () => {
		expect(mock.lifecycleHandlers.has("input")).toBe(true);
		expect(mock.lifecycleHandlers.get("input")!.length).toBe(1);
	});

	// ── Keyword detection ───────────────────────────────────────

	it("returns continue for non-matching input", async () => {
		const result = await fireInput(mock, "fix the bug");
		expect(result).toEqual({ action: "continue" });
	});

	it("returns continue for empty input", async () => {
		const result = await fireInput(mock, "");
		expect(result).toEqual({ action: "continue" });
	});

	it("detects 'ulw' at start of message", async () => {
		const result = await fireInput(mock, "ulw fix the bug");
		expect(result?.action).toBe("transform");
		expect((result as any).text).toContain("fix the bug");
		expect((result as any).text).toContain("<ultrawork-mode>");
	});

	it("detects 'ultrawork' at start of message", async () => {
		const result = await fireInput(mock, "ultrawork fix the bug");
		expect(result?.action).toBe("transform");
		expect((result as any).text).toContain("fix the bug");
	});

	it("detects keyword case-insensitively", async () => {
		const result = await fireInput(mock, "ULW fix the bug");
		expect(result?.action).toBe("transform");
	});

	it("detects keyword with leading whitespace", async () => {
		const result = await fireInput(mock, "  ulw fix the bug");
		expect(result?.action).toBe("transform");
	});

	it("detects keyword mid-sentence", async () => {
		const result = await fireInput(mock, "please use ulw mode");
		expect(result?.action).toBe("transform");
		const text = (result as any).text as string;
		expect(text).toContain("<ultrawork-mode>");
		expect(text).toContain("please use mode");
	});

	// ── Code-block protection ───────────────────────────────────

	it("does NOT trigger on keyword inside fenced code block", async () => {
		const result = await fireInput(mock, "```\nulw\n```\nfix this");
		expect(result).toEqual({ action: "continue" });
	});

	it("does NOT trigger on keyword inside inline code", async () => {
		const result = await fireInput(mock, "`ulw` fix this");
		expect(result).toEqual({ action: "continue" });
	});

	// ── @-reference protection ──────────────────────────────────

	it("does NOT trigger on @ulw file reference", async () => {
		const result = await fireInput(mock, "@ulw is not working");
		expect(result).toEqual({ action: "continue" });
	});

	it("does NOT trigger on @extensions/ulw/ reference", async () => {
		const result = await fireInput(mock, "@extensions/ulw/ is broken");
		expect(result).toEqual({ action: "continue" });
	});

	it("does NOT trigger on @extensions/ulw/index.ts reference", async () => {
		const result = await fireInput(mock, "check @extensions/ulw/index.ts for bugs");
		expect(result).toEqual({ action: "continue" });
	});

	it("strips only first keyword occurrence", async () => {
		const result = await fireInput(mock, "ulw fix the ulw bug");
		expect(result?.action).toBe("transform");
		const text = (result as any).text as string;
		const afterSep = text.split("---").pop()!;
		expect(afterSep.trim()).toBe("fix the ulw bug");
	});

	// ── Message-level injection ─────────────────────────────────

	it("prepends ultrawork prompt to user message", async () => {
		const result = await fireInput(mock, "ulw fix the bug");
		expect(result?.action).toBe("transform");
		const text = (result as any).text as string;
		// Prompt comes first, then separator, then user message
		const sepIdx = text.indexOf("---");
		const userMsgIdx = text.indexOf("fix the bug");
		expect(sepIdx).toBeGreaterThan(0);
		expect(userMsgIdx).toBeGreaterThan(sepIdx);
	});

	it("strips keyword from user message in output", async () => {
		const result = await fireInput(mock, "ulw fix the bug");
		const text = (result as any).text as string;
		// After the separator, the message should not contain "ulw"
		const afterSep = text.split("---").pop()!;
		expect(afterSep.trim()).toBe("fix the bug");
	});

	it("handles bare keyword with no task", async () => {
		const result = await fireInput(mock, "ulw");
		expect(result?.action).toBe("transform");
		const text = (result as any).text as string;
		expect(text).toContain("<ultrawork-mode>");
		expect(text).toContain("What task should I work on?");
	});

	// ── Mode gating ─────────────────────────────────────────────

	it("activates in kuafu mode (default)", async () => {
		const result = await fireInput(mock, "ulw fix it");
		expect(result?.action).toBe("transform");
		expect((result as any).text).toContain("<ultrawork-mode>");
	});

	it("activates when no mode entry exists (defaults to kuafu)", async () => {
		const ctx = createMockContext();
		// getEntries returns empty — no mode set
		const result = await fireInput(mock, "ulw fix it", ctx);
		expect(result?.action).toBe("transform");
		expect((result as any).text).toContain("<ultrawork-mode>");
	});

	it("skips injection in fuxi mode", async () => {
		const ctx = createCtxWithMode("fuxi");
		const result = await fireInput(mock, "ulw fix it", ctx);
		expect(result?.action).toBe("transform");
		// Should strip keyword but NOT inject ultrawork prompt
		expect((result as any).text).toBe("fix it");
		expect((result as any).text).not.toContain("<ultrawork-mode>");
	});

	it("skips injection in houtu mode", async () => {
		const ctx = createCtxWithMode("houtu");
		const result = await fireInput(mock, "ulw fix it", ctx);
		expect(result?.action).toBe("transform");
		expect((result as any).text).toBe("fix it");
	});

	it("returns continue for bare keyword in non-kuafu mode", async () => {
		const ctx = createCtxWithMode("fuxi");
		const result = await fireInput(mock, "ulw", ctx);
		// No task text after stripping → continue
		expect(result).toEqual({ action: "continue" });
	});

	it("handles broken sessionManager gracefully", async () => {
		const ctx = createMockContext();
		(ctx.sessionManager as any).getEntries = () => { throw new Error("boom"); };
		// Should fall back to kuafu and still activate
		const result = await fireInput(mock, "ulw fix it", ctx);
		expect(result?.action).toBe("transform");
		expect((result as any).text).toContain("<ultrawork-mode>");
	});

	// ── Notification ────────────────────────────────────────────

	it("calls notify on activation", async () => {
		const ctx = createMockContext();
		const calls: Array<{ text: string; level: string }> = [];
		ctx.ui.notify = ((text: string, level: string) => { calls.push({ text, level }); }) as any;
		await fireInput(mock, "ulw fix it", ctx);
		expect(calls).toHaveLength(1);
		expect(calls[0].text).toContain("Ultrawork Mode Activated");
		expect(calls[0].level).toBe("success");
	});

	it("calls notify with warning when skipped in non-kuafu mode", async () => {
		const ctx = createCtxWithMode("fuxi");
		const calls: Array<{ text: string; level: string }> = [];
		ctx.ui.notify = ((text: string, level: string) => { calls.push({ text, level }); }) as any;
		await fireInput(mock, "ulw fix it", ctx);
		expect(calls).toHaveLength(1);
		expect(calls[0].text).toContain("skipped");
		expect(calls[0].level).toBe("warning");
	});
});
