import { describe, it, expect, beforeEach } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { createMockContext } from "../../../test/fixtures/mock-context.js";

type InputResult =
	| { action: "continue" }
	| { action: "transform"; text: string }
	| { action: "handled" }
	| undefined;

type BeforeAgentStartResult = {
	message?: { customType: string; content: string; display: boolean };
	systemPrompt?: string;
} | undefined;

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

/**
 * Helper: call the extension's before_agent_start handler and return result.
 */
async function fireBeforeAgentStart(
	mock: ReturnType<typeof createMockPi>,
	ctx?: ReturnType<typeof createMockContext>,
): Promise<BeforeAgentStartResult> {
	const handlers = mock.lifecycleHandlers.get("before_agent_start") ?? [];
	if (handlers.length === 0) return undefined;
	const handler = handlers[0];
	return (await handler({ prompt: "", images: [], systemPrompt: "" }, ctx ?? createMockContext())) as BeforeAgentStartResult;
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

	it("registers an input handler and a before_agent_start handler", () => {
		expect(mock.lifecycleHandlers.has("input")).toBe(true);
		expect(mock.lifecycleHandlers.get("input")!.length).toBe(1);
		expect(mock.lifecycleHandlers.has("before_agent_start")).toBe(true);
		expect(mock.lifecycleHandlers.get("before_agent_start")!.length).toBe(1);
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
		expect((result as any).text).toBe("fix the bug");
		// Prompt is NOT in user message — it's injected via before_agent_start
		expect((result as any).text).not.toContain("<ultrawork-mode>");
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
		expect((result as any).text).toBe("please use mode");
		expect((result as any).text).not.toContain("<ultrawork-mode>");
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

	// ── Ultrawork prompt block protection ──────────────────────

	it("does NOT trigger on keyword inside <ultrawork-mode> block", async () => {
		const msg = "test<ultrawork-mode>\nultrawork prompt content\n</ultrawork-mode>";
		const result = await fireInput(mock, msg);
		expect(result).toEqual({ action: "continue" });
	});

	it("does NOT trigger on pasted ultrawork prompt with surrounding text", async () => {
		const msg = "here is the prompt <ultrawork-mode>ULTRAWORK MODE\nulw keyword inside</ultrawork-mode> what do you think";
		const result = await fireInput(mock, msg);
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
		expect((result as any).text).toBe("fix the ulw bug");
	});

	// ── Message injection via before_agent_start ───────────────

	it("injects ultrawork prompt as collapsed message via before_agent_start", async () => {
		await fireInput(mock, "ulw fix the bug");
		const result = await fireBeforeAgentStart(mock);
		expect(result?.message).toBeDefined();
		expect(result!.message!.customType).toBe("ultrawork");
		expect(result!.message!.content).toContain("<ultrawork-mode>");
		expect(result!.message!.display).toBe(false);
	});

	it("does NOT inject prompt on before_agent_start without prior keyword", async () => {
		await fireInput(mock, "fix the bug");
		const result = await fireBeforeAgentStart(mock);
		expect(result).toBeUndefined();
	});

	it("clears pending flag after before_agent_start fires", async () => {
		await fireInput(mock, "ulw fix it");
		await fireBeforeAgentStart(mock); // consumes flag
		const result = await fireBeforeAgentStart(mock); // should be empty
		expect(result).toBeUndefined();
	});

	it("handles bare keyword with no task", async () => {
		const result = await fireInput(mock, "ulw");
		expect(result?.action).toBe("transform");
		const text = (result as any).text as string;
		expect(text).toContain("What task should I work on?");
		// Prompt still injected via before_agent_start, not in user message
		expect(text).not.toContain("<ultrawork-mode>");
		const bas = await fireBeforeAgentStart(mock);
		expect(bas?.message?.content).toContain("<ultrawork-mode>");
	});

	// ── Mode gating ─────────────────────────────────────────────

	it("activates in kuafu mode (default)", async () => {
		const result = await fireInput(mock, "ulw fix it");
		expect(result?.action).toBe("transform");
		expect((result as any).text).toBe("fix it");
		const bas = await fireBeforeAgentStart(mock);
		expect(bas?.message?.content).toContain("<ultrawork-mode>");
	});

	it("activates when no mode entry exists (defaults to kuafu)", async () => {
		const ctx = createMockContext();
		// getEntries returns empty — no mode set
		const result = await fireInput(mock, "ulw fix it", ctx);
		expect(result?.action).toBe("transform");
		const bas = await fireBeforeAgentStart(mock);
		expect(bas?.message?.content).toContain("<ultrawork-mode>");
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

	it("does NOT set pending flag in non-kuafu mode", async () => {
		const ctx = createCtxWithMode("fuxi");
		await fireInput(mock, "ulw fix it", ctx);
		const bas = await fireBeforeAgentStart(mock);
		expect(bas).toBeUndefined();
	});

	it("handles broken sessionManager gracefully", async () => {
		const ctx = createMockContext();
		(ctx.sessionManager as any).getEntries = () => { throw new Error("boom"); };
		// Should fall back to kuafu and still activate
		const result = await fireInput(mock, "ulw fix it", ctx);
		expect(result?.action).toBe("transform");
		const bas = await fireBeforeAgentStart(mock);
		expect(bas?.message?.content).toContain("<ultrawork-mode>");
	});

	// ── Notification ────────────────────────────────────────────

	it("calls notify and setStatus on activation", async () => {
		const ctx = createMockContext();
		const notifyCalls: Array<{ text: string; level: string }> = [];
		const statusCalls: Array<{ id: string; text: string | undefined }> = [];
		ctx.ui.notify = ((text: string, level: string) => { notifyCalls.push({ text, level }); }) as any;
		ctx.ui.setStatus = ((id: string, text: string | undefined) => { statusCalls.push({ id, text }); }) as any;
		await fireInput(mock, "ulw fix it", ctx);
		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].text).toContain("Ultrawork Mode Activated");
		expect(notifyCalls[0].level).toBe("success");
		expect(statusCalls).toHaveLength(1);
		expect(statusCalls[0]).toEqual({ id: "ultrawork", text: "⚡ Ultrawork" });
	});

	it("calls notify with warning and clears status when skipped in non-kuafu mode", async () => {
		const ctx = createCtxWithMode("fuxi");
		const notifyCalls: Array<{ text: string; level: string }> = [];
		const statusCalls: Array<{ id: string; text: string | undefined }> = [];
		ctx.ui.notify = ((text: string, level: string) => { notifyCalls.push({ text, level }); }) as any;
		ctx.ui.setStatus = ((id: string, text: string | undefined) => { statusCalls.push({ id, text }); }) as any;
		await fireInput(mock, "ulw fix it", ctx);
		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].text).toContain("skipped");
		expect(notifyCalls[0].level).toBe("warning");
		expect(statusCalls).toHaveLength(1);
		expect(statusCalls[0]).toEqual({ id: "ultrawork", text: undefined });
	});
});
