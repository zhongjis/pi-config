import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";

type BeforeAgentStartResult = { systemPrompt: string } | undefined;

let originalHome: string | undefined;
let tempHome = "";

const SKILL_FIXTURE = `Prelude.

## Rules

rules

## Intensity

| **lite** | lite |
| **full** | full |
| **ultra** | ultra |

## Auto-Clarity

clarity

## Boundaries

boundaries
`;

async function writeSkillFixture(): Promise<void> {
	const skillPath = join(tempHome, ".pi", "agent", "skills", "caveman", "SKILL.md");
	await mkdir(dirname(skillPath), { recursive: true });
	await writeFile(skillPath, SKILL_FIXTURE);
}

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

function getCavemanCommand(mock: ReturnType<typeof createMockPi>) {
	return mock.commands.get("caveman") as {
		getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string }> | null;
		handler: (args: string, ctx: ReturnType<typeof createPersistedContext>) => Promise<void>;
	};
}

describe("caveman extension", () => {
	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await mkdtemp(join(tmpdir(), "caveman-extension-home-"));
		process.env.HOME = tempHome;
		await writeSkillFixture();
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		if (tempHome) {
			await rm(tempHome, { force: true, recursive: true });
		}
	});

	it("injects a non-empty prompt patch for top-level persisted sessions", async () => {
		const mock = await registerFreshExtension();
		const ctx = createPersistedContext();
		await mock.fireLifecycle("session_start", {}, ctx);

		const result = await fireBeforeAgentStart(mock, ctx);

		expect(result).toBeDefined();
		expect(result?.systemPrompt.startsWith("Base prompt\n\n")).toBe(true);
		expect(result?.systemPrompt.length).toBeGreaterThan("Base prompt\n\n".length);
	});

	it("injects into non-persisted subagent sessions", async () => {
		const mock = await registerFreshExtension();
		const ctx = createPersistedContext();
		(ctx.sessionManager as any).isPersisted = () => false;
		(ctx.sessionManager as any).getSessionFile = () => undefined;
		await mock.fireLifecycle("session_start", {}, ctx);

		const result = await fireBeforeAgentStart(mock, ctx);

		expect(result).toBeDefined();
		expect(result?.systemPrompt.startsWith("Base prompt\n\n")).toBe(true);
		expect(result?.systemPrompt.length).toBeGreaterThan("Base prompt\n\n".length);
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

	it("stays inactive when the skill source is missing", async () => {
		await rm(join(tempHome, ".pi", "agent", "skills", "caveman", "SKILL.md"));
		const mock = await registerFreshExtension();
		const ctx = createPersistedContext();
		const skillPath = join(tempHome, ".pi", "agent", "skills", "caveman", "SKILL.md");

		await expect(mock.fireLifecycle("session_start", {}, ctx)).resolves.toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			`Caveman inactive: Caveman prompt source not found: ${skillPath}`,
			"warning",
		);
		await expect(fireBeforeAgentStart(mock, ctx)).resolves.toBeUndefined();
	});

	it("disables injection when /caveman off overrides a configured level", async () => {
		await writeFile(
			join(tempHome, ".pi", "agent", "caveman.json"),
			JSON.stringify({ defaultLevel: "full", statusVisibility: "active" }),
		);
		const mock = await registerFreshExtension();
		const appendEntry = vi.spyOn(mock.pi, "appendEntry");
		const ctx = createPersistedContext();
		await mock.fireLifecycle("session_start", {}, ctx);
		const command = getCavemanCommand(mock);

		const beforeOff = await fireBeforeAgentStart(mock, ctx);
		expect(beforeOff?.systemPrompt.startsWith("Base prompt\n\n")).toBe(true);

		await command.handler("off", ctx);

		expect(appendEntry).toHaveBeenCalledWith("caveman-level", { level: "off" });
		expect(ctx.ui.notify).toHaveBeenCalledWith("Caveman disabled for this session.", "info");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("caveman", undefined);
		await expect(fireBeforeAgentStart(mock, ctx)).resolves.toBeUndefined();

		await command.handler("off", ctx);
		expect(appendEntry).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Caveman already off for this session.", "info");

		await command.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Current level: off (session override)"),
			"info",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Accepted levels: lite | full | ultra | off"),
			"info",
		);
	});

	it("registers only supported command completions", async () => {
		const mock = await registerFreshExtension();
		const command = getCavemanCommand(mock);

		expect(command.getArgumentCompletions("")?.map((item) => item.value)).toEqual([
			"lite",
			"full",
			"ultra",
			"off",
			"config",
		]);
		expect(command.getArgumentCompletions("off")).toEqual([
			{ value: "off", label: "off — disable caveman for this session" },
		]);
		expect(command.getArgumentCompletions("w")).toBeNull();
	});
});
