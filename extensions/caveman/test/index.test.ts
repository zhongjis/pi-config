import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";

type BeforeAgentStartResult = { systemPrompt: string } | undefined;

let originalHome: string | undefined;
let tempHome = "";

async function registerFreshExtension() {
	vi.resetModules();
	const mock = createMockPi();
	const mod = await import("../index.js");
	mod.default(mock.pi as never);
	return mock;
}

function createPersistedContext() {
	const ctx = createMockContext();
	(ctx.ui as any).notify = vi.fn();
	(ctx.ui as any).setStatus = vi.fn();
	(ctx.sessionManager as any).getBranch = () => [];
	(ctx.sessionManager as any).isPersisted = () => true;
	(ctx.sessionManager as any).getSessionFile = () => "/tmp/caveman-session.jsonl";
	return ctx;
}

async function fireBeforeAgentStart(
	mock: ReturnType<typeof createMockPi>,
	ctx: ReturnType<typeof createMockContext>,
	systemPrompt = "Base prompt",
): Promise<BeforeAgentStartResult> {
	const handlers = mock.lifecycleHandlers.get("before_agent_start") ?? [];
	expect(handlers.length).toBeGreaterThan(0);
	return (await handlers[0]({ systemPrompt }, ctx)) as BeforeAgentStartResult;
}

describe("caveman extension", () => {
	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await mkdtemp(join(tmpdir(), "caveman-extension-home-"));
		process.env.HOME = tempHome;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		if (tempHome) {
			await rm(tempHome, { force: true, recursive: true });
		}
	});

	it("injects the synced caveman prompt for top-level persisted sessions", async () => {
		const mock = await registerFreshExtension();
		const ctx = createPersistedContext();
		await mock.fireLifecycle("session_start", {}, ctx);

		const result = await fireBeforeAgentStart(mock, ctx);

		expect(result?.systemPrompt).toContain("Base prompt\n\n");
		expect(result?.systemPrompt).toContain("Active level: ultra.");
		expect(result?.systemPrompt).toContain("Preserve user's dominant language");
		expect(result?.systemPrompt).toContain("No self-reference");
	});

	it("injects into non-persisted subagent sessions", async () => {
		const mock = await registerFreshExtension();
		const ctx = createPersistedContext();
		(ctx.sessionManager as any).isPersisted = () => false;
		(ctx.sessionManager as any).getSessionFile = () => undefined;
		await mock.fireLifecycle("session_start", {}, ctx);

		const result = await fireBeforeAgentStart(mock, ctx);

		expect(result?.systemPrompt).toContain("Active level: ultra.");
	});

	it("does not inject when the caveman level is off", async () => {
		const configDir = join(tempHome, ".pi", "agent");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			join(configDir, "caveman.json"),
			JSON.stringify({ defaultLevel: "off", statusVisibility: "active" }),
		);
		const mock = await registerFreshExtension();
		const ctx = createPersistedContext();
		await mock.fireLifecycle("session_start", {}, ctx);

		await expect(fireBeforeAgentStart(mock, ctx)).resolves.toBeUndefined();
	});

	it("registers only supported command completions", async () => {
		const mock = await registerFreshExtension();
		const command = mock.commands.get("caveman") as {
			getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null;
		};

		expect(command.getArgumentCompletions("")?.map((item) => item.value)).toEqual(["lite", "full", "ultra", "config"]);
		expect(command.getArgumentCompletions("w")).toBeNull();
	});
});
