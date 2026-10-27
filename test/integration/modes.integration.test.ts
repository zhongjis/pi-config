import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentSystemMessage, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	createTestSession,
	when,
	calls,
	says,
	type TestSession,
} from "./helpers/faux-session.js";
import * as path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const EXTENSION = path.resolve(PROJECT_ROOT, "extensions/modes/src/index.ts");
const SUBAGENTS_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/subagents/src/index.ts");
const INLINE_SKILLS_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/inline-skills/index.ts");
const SMART_TOOL_GUARDS_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/smart-tool-guards/index.ts");

const MOCK_TOOLS = {
	bash: (params: Record<string, unknown>) => `$ ${params.command}\nok`,
	read: "mock file contents",
	write: "mock written",
	edit: "mock edited",
};

/**
 * Switch the modes extension to a given mode by invoking the /mode command
 * through the session's prompt handler (slash commands execute synchronously
 * without engaging the model).
 */
async function switchMode(t: TestSession, mode: string): Promise<void> {
	await (t.session as any).prompt(`/mode ${mode}`);
}

async function switchModeCommand(t: TestSession, mode: string): Promise<void> {
	await (t.session as any).prompt(`/mode:${mode}`);
}

async function executePlanApprove(t: TestSession): Promise<any> {
	const runner = (t.session as any).extensionRunner;
	const tool = runner.getToolDefinition("plan_approve");
	expect(tool).toBeDefined();
	return tool.execute("tool-plan-approve", { variant: "post-gap-review" }, undefined, undefined, runner.createContext());
}

function skillNames(t: TestSession): string[] {
	return [...((t.session as any).resourceLoader.getSkills().skills as Array<{ name: string }>)]
		.map((skill) => skill.name)
		.sort();
}

async function bindReloadCommandContext(t: TestSession): Promise<void> {
	await (t.session as any).bindExtensions({
		commandContextActions: {
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {
				await (t.session as any).reload();
			},
		},
	});
}

describe("modes extension — integration", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	// ── Loading & registration ──────────────────────────────────

	it("loads without errors and exposes plan_approve only in fuxi mode", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		const runner = (t.session as any).extensionRunner;
		expect(runner.getToolDefinition("plan_approve")).toBeDefined();

		// Pi activates plan_approve on registration; outside fuxi the mode ceiling
		// hides its declaration from the model.
		const declaredToolNames = () => {
			const hidden = (t.session as any)._hiddenDeclarations as Set<string>;
			const tools = (t.session.agent as any).state.tools as Array<{ name: string }>;
			return tools.map((tool) => tool.name).filter((name) => !hidden.has(name));
		};
		expect(declaredToolNames()).not.toContain("plan_approve");

		await switchMode(t, "fuxi");

		expect(declaredToolNames()).toContain("plan_approve");
	});

	it("scaffolds canonical session-local artifacts and feeds plan approval", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});
		await switchMode(t, "fuxi");

		const runner = (t.session as any).extensionRunner;
		const tool = runner.getToolDefinition("plan_scaffold");
		expect(tool).toBeDefined();
		const result = await tool.execute(
			"tool-plan-scaffold",
			{ slug: "integration-plan", intent: "clear" },
			undefined,
			undefined,
			runner.createContext(),
		);
		const artifacts = result.details.artifacts as Array<{ path: string; backingPath: string; status: string }>;
		const draft = artifacts.find((artifact) => artifact.path === "local://DRAFT.md");
		const plan = artifacts.find((artifact) => artifact.path === "local://PLAN.md");
		expect(draft?.status).toBe("created");
		expect(plan?.status).toBe("created");
		expect(await readFile(plan!.backingPath, "utf8")).toContain("## Todos");
		expect(await readFile(plan!.backingPath, "utf8")).toContain("## Final verification wave");
		const approval = await executePlanApprove(t);
		expect(approval.details).toEqual({ variant: "post-gap-review" });
		expect(approval.content[0]?.text).not.toContain("Error: No plan found");
		await rm(path.dirname(plan!.backingPath), { recursive: true, force: true });
	});

	it("discovers only active-mode skills without context bootstrap", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		const fuxiSkillsDir = path.resolve(PROJECT_ROOT, "modes/fuxi/skills");
		const kuafuSkillsDir = path.resolve(PROJECT_ROOT, "modes/kuafu/skills");
		const discoveredPaths = async () => {
			const runner = (t.session as any).extensionRunner;
			const resources = await runner.emitResourcesDiscover(PROJECT_ROOT, "reload");
			return resources.skillPaths.map((resource: { path: string }) => resource.path);
		};
		const expectPaths = async (expected: string[]) => {
			expect(await discoveredPaths()).toEqual(expected);
			const runner = (t.session as any).extensionRunner;
			const context = JSON.stringify(await runner.emitContext([]));
			expect(context).not.toContain("mode-skill-bootstrap:");
		};

		await expectPaths([kuafuSkillsDir]);
		await switchMode(t, "fuxi");
		await expectPaths([fuxiSkillsDir]);
		await switchMode(t, "houtu");
		await expectPaths([]);
		await switchMode(t, "kuafu");
		await expectPaths([kuafuSkillsDir]);
	});

	it("updates mode-owned skill inventory after real /mode reload with inline-skills loaded", async () => {
		t = await createTestSession({
			extensions: [EXTENSION, INLINE_SKILLS_EXTENSION],
			mockTools: MOCK_TOOLS,
		});
		await bindReloadCommandContext(t);
		const runner = (t.session as any).extensionRunner;
		expect(runner.getCommand("loaded-skills")).toBeDefined();

		let names = skillNames(t);
		expect(names).not.toContain("ulw-plan");

		await switchModeCommand(t, "fuxi");
		names = skillNames(t);
		expect(names).toContain("ulw-plan");

		await switchModeCommand(t, "houtu");
		names = skillNames(t);
		expect(names).not.toContain("ulw-plan");
	});

	// ── Default mode (kuafu) allows writes ──────────────────────

	it("kuafu mode allows write to arbitrary files", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await t.run(
			when("Write a file", [
				calls("write", { path: "src/foo.ts", content: "hello" }),
				says("Done."),
			]),
		);

		const blocked = t.events.blockedCalls();
		expect(blocked).toHaveLength(0);

		const writeResults = t.events.toolResultsFor("write");
		expect(writeResults).toHaveLength(1);
		expect(writeResults[0].mocked).toBe(true);
	});

	it("kuafu mode allows arbitrary bash commands", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await t.run(
			when("Run a command", [
				calls("bash", { command: "rm -rf /tmp/test" }),
				says("Done."),
			]),
		);

		const blocked = t.events.blockedCalls();
		expect(blocked).toHaveLength(0);
	});

	// ── Fu Xi plan mode: blocks non-plan writes ─────────────────

	it("fuxi mode blocks write to non-plan files", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		await t.run(
			when("Write a source file", [
				calls("write", { path: "src/foo.ts", content: "hello" }),
				says("Blocked."),
			]),
		);

		const blocked = t.events.blockedCalls();
		expect(blocked).toHaveLength(1);
		expect(blocked[0].toolName).toBe("write");
		expect(blocked[0].blockReason).toContain("Plan mode");
	});

	it("fuxi mode blocks edit to non-plan files", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		await t.run(
			when("Edit a source file", [
				calls("edit", { path: "src/bar.ts", edits: [] }),
				says("Blocked."),
			]),
		);

		const blocked = t.events.blockedCalls();
		expect(blocked).toHaveLength(1);
		expect(blocked[0].toolName).toBe("edit");
		expect(blocked[0].blockReason).toContain("Plan mode");
	});

	// ── Fu Xi plan mode: allows plan file writes ─────────────────

	it("fuxi mode allows write to local://PLAN.md", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		await t.run(
			when("Write the plan", [
				calls("write", { path: "local://PLAN.md", content: "# Plan\n\nStep 1" }),
				says("Plan written."),
			]),
		);

		const blocked = t.events.blockedCalls();
		expect(blocked).toHaveLength(0);

		const writeResults = t.events.toolResultsFor("write");
		expect(writeResults).toHaveLength(1);
	});

	// ── Fu Xi plan mode: smart-guarded built-in bash ──────────────
	it("fails closed for Fu Xi bash when smart guard is omitted", async () => {
		const bash = vi.fn((params: Record<string, unknown>) => `$ ${params.command}\nok`);
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { ...MOCK_TOOLS, bash },
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");
		await t.run(
			when("Inspect git status", [
				calls("bash", { command: "git status" }),
				says("Blocked."),
			]),
		);

		expect(bash).not.toHaveBeenCalled();
		const [result] = t.events.toolResultsFor("bash");
		expect(result).toMatchObject({ isError: true });
		expect(result.text).toMatch(/smart guard.*not registered/i);
	});

	it("allows deterministic-safe Fu Xi bash after real mode reload", async () => {
		const bash = vi.fn((params: Record<string, unknown>) => `$ ${params.command}\nok`);
		t = await createTestSession({
			extensions: [EXTENSION, SMART_TOOL_GUARDS_EXTENSION],
			mockTools: { ...MOCK_TOOLS, bash },
			propagateErrors: false,
		});
		await bindReloadCommandContext(t);
		const previousRunner = (t.session as any).extensionRunner;

		await switchModeCommand(t, "fuxi");
		expect((t.session as any).extensionRunner).not.toBe(previousRunner);
		await t.run(
			when("Inspect current directory", [
				calls("bash", { command: "pwd" }),
				says("Done."),
			]),
		);

		expect(bash).toHaveBeenCalledOnce();
		expect(t.events.toolResultsFor("bash")).toHaveLength(1);
		expect(t.events.toolResultsFor("bash")[0].isError).toBe(false);
	});

	it("blocks deterministic-dangerous Fu Xi bash after real mode reload", async () => {
		const bash = vi.fn((params: Record<string, unknown>) => `$ ${params.command}\nok`);
		t = await createTestSession({
			extensions: [EXTENSION, SMART_TOOL_GUARDS_EXTENSION],
			mockTools: { ...MOCK_TOOLS, bash },
			propagateErrors: false,
		});
		await bindReloadCommandContext(t);

		await switchModeCommand(t, "fuxi");
		await t.run(
			when("Run destructive command", [
				calls("bash", { command: "rm -rf /tmp/test" }),
				says("Blocked."),
			]),
		);

		expect(bash).not.toHaveBeenCalled();
		const [result] = t.events.toolResultsFor("bash");
		expect(result).toMatchObject({ isError: true });
		expect(result.text).toBe([
			"[Smart Guard][BLOCK][source=policy][profile=bash-read-only-v1][scope=modes:fuxi]",
			"Bash not run: Read-only policy matched: filesystem-mutation. Guard active: Fuxi plan mode requires read-only Bash. Agent capability restriction: this agent is not authorized to run this Bash action; this does not establish a project-wide lack of access. Report the capability limitation and that the command was not executed.",
		].join("\n"));
	});

	// ── Mode switching via command ──────────────────────────────

	it("switching back to kuafu re-enables writes", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		// Switch to fuxi, then back to kuafu
		await switchMode(t, "fuxi");
		await switchMode(t, "kuafu");

		await t.run(
			when("Write a file after switching back", [
				calls("write", { path: "src/foo.ts", content: "hello" }),
				says("Written."),
			]),
		);

		const blocked = t.events.blockedCalls();
		expect(blocked).toHaveLength(0);
	});

	// ── Plan approve tool ───────────────────────────────────────

	it("plan_approve tool is callable", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			mockUI: {
				select: 0,  // Pick first option in approval menu
			},
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		const result = await executePlanApprove(t);

		expect(result.content[0].text).not.toContain("blocked");
		expect(result.details.variant).toBe("post-gap-review");
	});
});

describe("modes + subagents agent roster — integration", () => {
	const previousEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	let home: string;
	let agentDir: string;
	let t: TestSession | undefined;

	beforeEach(() => {
		home = mkdtempSync(path.join(tmpdir(), "pi-roster-home-"));
		agentDir = path.join(home, ".pi", "agent");
		const writeMode = (mode: string, body: string) => {
			mkdirSync(path.join(agentDir, "modes", mode), { recursive: true });
			writeFileSync(path.join(agentDir, "modes", mode, "default.md"), `---\ntools: +@all\ndelegation: +alpha, +beta\n---\n\n${body}\n`);
		};
		writeMode("kuafu", "Kua Fu fixture.\n\nRoster:\n{{agentRoster}}");
		writeMode("fuxi", "Fu Xi fixture without a roster.");
		mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		for (const name of ["alpha", "beta", "gamma"]) {
			writeFileSync(path.join(agentDir, "agents", `${name}.md`), `---\ndescription: ${name} worker. Extra detail.\n---\nWork.\n`);
		}
		// Mode prompts load from homedir(); subagent definitions and settings from the agent dir.
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		// Release the root manager bridge before the next session claims it.
		const runner = t?.session.extensionRunner;
		if (runner?.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown" });
		t?.dispose();
		t = undefined;
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
	});

	const rosterRows = (text: string | null | undefined) =>
		(text ?? "").split("\n").filter((line) => /^- (alpha|beta|gamma):/.test(line)).map((line) => line.split(":")[0]);

	it.each(["full", "compact", "custom"].flatMap((descriptionMode) => [
		{ descriptionMode, order: "modes first", extensions: [EXTENSION, SUBAGENTS_EXTENSION] },
		{ descriptionMode, order: "subagents first", extensions: [SUBAGENTS_EXTENSION, EXTENSION] },
	]))("places the mode-permitted roster per mode across switches ($descriptionMode, $order)", async ({ descriptionMode, extensions }) => {
		writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ toolDescriptionMode: descriptionMode }));
		writeFileSync(path.join(agentDir, "agent-tool-description.md"), "Agents:\n{{typeList}}\nCompact:\n{{compactTypeList}}");
		const requests: Array<{ sections: Record<string, string | null>; agentDescription: string | undefined }> = [];
		const capture = (context: TranscriptContext) => {
			requests.push({
				sections: getCurrentSystemMessage(context.messages)?.sections ?? {},
				agentDescription: getCurrentTools(context.messages).find((tool) => tool.name === "agent")?.description,
			});
			return undefined;
		};
		t = await createTestSession({ extensions, fauxResponseRouter: capture });
		const listedDescription: string = t.session.extensionRunner.getToolDefinition("agent").description;
		expect(rosterRows(listedDescription).length).toBeGreaterThan(0);

		await t.run(when("Roster mode", [says("Done.")]));
		await switchMode(t, "fuxi");
		await t.run(when("Hint mode", [says("Done.")]));
		await switchMode(t, "kuafu");
		await t.run(when("Roster mode again", [says("Done.")]));

		const [kuafu, fuxi, kuafuAgain] = requests;
		expect(rosterRows(kuafu?.sections.modes)).toEqual(["- alpha", "- beta"]);
		expect(kuafu?.sections.modes).not.toContain("{{agentRoster}}");
		expect(kuafu?.sections.subagents ?? null).toBeNull();
		expect(kuafu?.agentDescription).toBeDefined();
		expect(rosterRows(kuafu?.agentDescription)).toEqual([]);

		expect(fuxi?.sections.modes).toContain("Fu Xi fixture without a roster.");
		expect(fuxi?.sections.subagents).toContain("alpha, beta");
		expect(fuxi?.agentDescription).toBe(listedDescription);

		expect(kuafuAgain?.sections.modes).toBe(kuafu?.sections.modes);
		expect(kuafuAgain?.sections.subagents ?? null).toBeNull();
		expect(kuafuAgain?.agentDescription).toBe(kuafu?.agentDescription);
	});
});
