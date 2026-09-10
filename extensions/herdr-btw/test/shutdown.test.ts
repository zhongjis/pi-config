import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { ContextStore } from "../src/context-store.ts";
import { createPayload } from "../src/core.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

function makePayloadOptions(closeOnExit: boolean, parentPaneId: string | null = "%pane-parent") {
	return {
		createdAt: new Date().toISOString(),
		parentSessionId: "test-session-shutdown",
		parentPaneId,
		metadata: {
			generatedAt: new Date().toISOString(),
			cwd: "/tmp",
			session: "test-session-shutdown",
			model: "anthropic/claude-opus-4-5",
		},
		parentSystemPrompt: null,
		parentActiveTools: [],
		parentThinkingLevel: "medium",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
		draftQuestion: "",
		config: { ...DEFAULT_CONFIG, closeOnExit },
	};
}

// S5: auto-close on quit
describe("child pane auto-close on session_shutdown", () => {
	let tempDir: string;
	let savedPayloadEnv: string | undefined;
	let savedPaneIdEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "herdr-btw-test-"));
		savedPayloadEnv = process.env.PI_HERDR_BTW_PAYLOAD;
		savedPaneIdEnv = process.env.HERDR_PANE_ID;
	});

	afterEach(async () => {
		// Restore env vars
		if (savedPayloadEnv === undefined) {
			delete process.env.PI_HERDR_BTW_PAYLOAD;
		} else {
			process.env.PI_HERDR_BTW_PAYLOAD = savedPayloadEnv;
		}
		if (savedPaneIdEnv === undefined) {
			delete process.env.HERDR_PANE_ID;
		} else {
			process.env.HERDR_PANE_ID = savedPaneIdEnv;
		}
		await rm(tempDir, { recursive: true, force: true });
		vi.resetModules();
	});

	it("closes the own pane and focuses parent when closeOnExit is true and reason is quit", async () => {
		const store = new ContextStore(tempDir);
		const payload = createPayload(makePayloadOptions(true, "%pane-parent"));
		const payloadPath = await store.create(payload);

		process.env.PI_HERDR_BTW_PAYLOAD = payloadPath;
		process.env.HERDR_PANE_ID = "%pane-child";

		vi.resetModules();
		const mock = createMockPi();
		const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		(mock.pi as unknown as Record<string, unknown>).exec = exec;

		const mod = await import("../index.ts");
		await mod.default(mock.pi as never, { store });

		await mock.fireLifecycle("session_shutdown", { reason: "quit" });

		expect(exec).toHaveBeenCalledWith("herdr", ["agent", "focus", "%pane-parent"], expect.objectContaining({ timeout: 5_000 }));
		expect(exec).toHaveBeenCalledWith("herdr", ["pane", "close", "%pane-child"], expect.objectContaining({ timeout: 5_000 }));
	});

	it("does NOT close the pane when closeOnExit is false", async () => {
		const store = new ContextStore(tempDir);
		const payload = createPayload(makePayloadOptions(false, "%pane-parent"));
		const payloadPath = await store.create(payload);

		process.env.PI_HERDR_BTW_PAYLOAD = payloadPath;
		process.env.HERDR_PANE_ID = "%pane-child";

		vi.resetModules();
		const mock = createMockPi();
		const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		(mock.pi as unknown as Record<string, unknown>).exec = exec;

		const mod = await import("../index.ts");
		await mod.default(mock.pi as never, { store });

		await mock.fireLifecycle("session_shutdown", { reason: "quit" });

		const closeCalls = exec.mock.calls.filter(
			(call) => Array.isArray(call[1]) && call[1].includes("close"),
		);
		expect(closeCalls).toHaveLength(0);
	});

	it("does NOT close the pane when reason is reload (even with closeOnExit: true)", async () => {
		const store = new ContextStore(tempDir);
		const payload = createPayload(makePayloadOptions(true, "%pane-parent"));
		const payloadPath = await store.create(payload);

		process.env.PI_HERDR_BTW_PAYLOAD = payloadPath;
		process.env.HERDR_PANE_ID = "%pane-child";

		vi.resetModules();
		const mock = createMockPi();
		const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		(mock.pi as unknown as Record<string, unknown>).exec = exec;

		const mod = await import("../index.ts");
		await mod.default(mock.pi as never, { store });

		await mock.fireLifecycle("session_shutdown", { reason: "reload" });

		const closeCalls = exec.mock.calls.filter(
			(call) => Array.isArray(call[1]) && call[1].includes("close"),
		);
		expect(closeCalls).toHaveLength(0);
	});
});
