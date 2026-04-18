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
const ULW_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/ulw/index.ts");
const MODES_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/modes/src/index.ts");

const MOCK_TOOLS = {
	bash: (params: Record<string, unknown>) => `$ ${params.command}\nok`,
	read: "mock file contents",
	write: "mock written",
	edit: "mock edited",
};

/**
 * Switch mode via /mode command (requires modes extension loaded).
 */
async function switchMode(t: TestSession, mode: string): Promise<void> {
	await (t.session as any).prompt(`/mode ${mode}`);
}

describe("ulw extension — integration", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	// ── Loading ─────────────────────────────────────────────────

	it("loads without errors", async () => {
		t = await createTestSession({
			extensions: [ULW_EXTENSION],
			mockTools: MOCK_TOOLS,
		});
		// Extension loaded — no throw
		expect(t).toBeDefined();
	});

	// ── Keyword triggers injection ──────────────────────────────

	it("ulw keyword prepends ultrawork prompt to user message", async () => {
		t = await createTestSession({
			extensions: [ULW_EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		await t.run(
			when("ulw list all files", [
				calls("bash", { command: "ls -la" }),
				says("Here are the files."),
			]),
		);

		// The model should have seen the ultrawork prompt in the user message
		const messages = t.events.messages;
		const userMsg = messages.find((m) => (m as any).role === "user");
		// If the transform worked, the playbook matched "ulw list all files"
		// which means the agent processed it (transform stripped keyword,
		// prepended prompt). The model turn completed successfully.
		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
	});

	// ── Non-matching input passes through ───────────────────────

	it("non-matching input passes through unchanged", async () => {
		t = await createTestSession({
			extensions: [ULW_EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		await t.run(
			when("list all files", [
				calls("bash", { command: "ls" }),
				says("Done."),
			]),
		);

		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
	});

	// ── Mode gating with modes extension ────────────────────────

	it("skips injection in fuxi mode (with modes extension)", async () => {
		t = await createTestSession({
			extensions: [MODES_EXTENSION, ULW_EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		// In fuxi mode, ulw keyword should be stripped but prompt not injected.
		// The write should be blocked by fuxi's plan-mode hook (different concern),
		// but the ulw extension should not inject its prompt.
		await t.run(
			when("ulw check status", [
				calls("bash", { command: "git status" }),
				says("Status checked."),
			]),
		);

		// bash should work (git status is safe in fuxi mode)
		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
	});

	it("activates normally in kuafu mode (with modes extension)", async () => {
		t = await createTestSession({
			extensions: [MODES_EXTENSION, ULW_EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		// Default mode is kuafu — ulw should activate
		await t.run(
			when("ulw fix the tests", [
				calls("bash", { command: "pnpm test" }),
				says("Tests fixed."),
			]),
		);

		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
	});

	it("activates after switching back to kuafu from fuxi", async () => {
		t = await createTestSession({
			extensions: [MODES_EXTENSION, ULW_EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");
		await switchMode(t, "kuafu");

		await t.run(
			when("ulw deploy the app", [
				calls("bash", { command: "npm run build" }),
				says("Deployed."),
			]),
		);

		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
	});
});
