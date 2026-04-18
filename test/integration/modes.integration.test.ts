import { describe, it, expect, afterEach } from "vitest";
import {
	createTestSession,
	when,
	calls,
	says,
	type TestSession,
} from "@marcfargas/pi-test-harness";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const EXTENSION = path.resolve(PROJECT_ROOT, "extensions/modes/src/index.ts");

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

describe("modes extension — integration", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	// ── Loading & registration ──────────────────────────────────

	it("loads without errors and registers plan_approve tool", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		const tools = (t.session.agent as any).state.tools as Array<{ name: string }>;
		const toolNames = tools.map((tool) => tool.name);
		expect(toolNames).toContain("plan_approve");
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

	// ── Fu Xi plan mode: bash command filtering ─────────────────

	it("fuxi mode allows safe bash commands (read-only)", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		await t.run(
			when("List files", [
				calls("bash", { command: "cat README.md" }),
				says("Here are the contents."),
			]),
		);

		const blocked = t.events.blockedCalls();
		expect(blocked).toHaveLength(0);

		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
		expect(bashResults[0].mocked).toBe(true);
	});

	it("fuxi mode blocks unsafe bash commands", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		await t.run(
			when("Run destructive command", [
				calls("bash", { command: "rm -rf /tmp/test" }),
				says("Blocked."),
			]),
		);

		const blocked = t.events.blockedCalls();
		expect(blocked).toHaveLength(1);
		expect(blocked[0].toolName).toBe("bash");
		expect(blocked[0].blockReason).toContain("Plan mode");
		expect(blocked[0].blockReason).toContain("not read-only");
	});

	it("fuxi mode allows multiple safe bash prefixes", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		await t.run(
			when("Run git and grep", [
				calls("bash", { command: "git status" }),
				calls("bash", { command: "grep -r TODO src/" }),
				calls("bash", { command: "ls -la" }),
				says("Done."),
			]),
		);

		const blocked = t.events.blockedCalls();
		expect(blocked).toHaveLength(0);

		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(3);
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

		await t.run(
			when("Approve the plan", [
				calls("plan_approve", { variant: "post-gap-review" }),
				says("Plan approved."),
			]),
		);

		const results = t.events.toolResultsFor("plan_approve");
		expect(results).toHaveLength(1);
		// The tool should execute (not be blocked)
		const blocked = t.events.blockedCalls();
		const planBlocked = blocked.filter((b) => b.toolName === "plan_approve");
		expect(planBlocked).toHaveLength(0);
	});
});
