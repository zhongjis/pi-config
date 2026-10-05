import { describe, it, expect, afterEach } from "vitest";
import {
	createTestSession,
	when,
	calls,
	says,
	type TestSession,
} from "./helpers/faux-session.js";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ULW_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/ulw/index.ts");
const MODES_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/modes/src/index.ts");
const SMART_TOOL_GUARDS_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/smart-tool-guards/index.ts");

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

	it("ulw keyword injects a separate ultrawork message and preserves user text", async () => {
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

		expect(t.events.messages.filter((m) => "customType" in m && m.customType === "ultrawork")).toHaveLength(1);
		expect(t.events.messages.find((m) => m.role === "user")).toMatchObject({
			content: [{ type: "text", text: "ulw list all files" }],
		});
		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
	});

	it.each([
		["ulw", true], ["ultrawork", true], ["  ulw fix this", true],
		["UlW fix this", true], ["please use ulw mode", true],
		["fix this ulw", true], ["ulw fix this", true],
		["please\tULTRAWORK\nfix this", true],
		["@extensions/ulw/", false], ["ulw-loop", false],
		['"ulw"', false], ["'ulw'", false], ["/ulw", false], ["\\ulw", false],
		["extensions/ulw/index.ts", false], ["extensions\\ulw\\index.ts", false],
		["ulw, fix this", false], ["please (ulw) fix this", false],
		["fix this ulw.", false], ["ultrawork-loop", false],
		['"UlTrAwOrK"', false], ["ultrawork: fix this", false],
	])("input %j has ultrawork activation %j", async (text, activates) => {
		t = await createTestSession({ extensions: [ULW_EXTENSION] });
		await t.run(when(text, [says("Done.")]));
		expect(t.events.messages.filter((m) => "customType" in m && m.customType === "ultrawork"))
			.toHaveLength(activates ? 1 : 0);
		expect(t.events.messages.find((m) => m.role === "user")).toMatchObject({
			content: [{ type: "text", text: text.trim() === "ulw" || text.trim() === "ultrawork"
				? "Ultrawork mode is now active." : text }],
		});
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
		expect(t.events.messages.filter((m) => "customType" in m && m.customType === "ultrawork")).toHaveLength(0);
	});

	// ── Mode gating with modes extension ────────────────────────

	it("skips injection in fuxi mode while smart guard permits safe bash", async () => {
		t = await createTestSession({
			extensions: [MODES_EXTENSION, SMART_TOOL_GUARDS_EXTENSION, ULW_EXTENSION],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		// Fu Xi suppresses ultrawork injection; smart guard independently allows
		// this deterministic read-only command through built-in bash.
		await t.run(
			when("ulw check status", [
				calls("bash", { command: "git status" }),
				says("Status checked."),
			]),
		);

		expect(t.events.messages.filter((m) => "customType" in m && m.customType === "ultrawork")).toHaveLength(0);
		expect(t.events.blockedCalls()).toHaveLength(0);
		expect(t.events.toolResultsFor("bash")).toHaveLength(1);
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

		expect(t.events.messages.filter((m) => "customType" in m && m.customType === "ultrawork")).toHaveLength(1);
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

		expect(t.events.messages.filter((m) => "customType" in m && m.customType === "ultrawork")).toHaveLength(1);
		const bashResults = t.events.toolResultsFor("bash");
		expect(bashResults).toHaveLength(1);
	});
});
