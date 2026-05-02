import { afterEach, describe, expect, it } from "vitest";
import {
	calls,
	createTestSession,
	says,
	when,
	type TestSession,
} from "@marcfargas/pi-test-harness";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SUBAGENT_SOURCE = path.join(PROJECT_ROOT, "extensions/subagent/index.ts");
const MATRIX_AGENT = "jintong";
const MATRIX_AGENT_NESTED = "chengfeng";

let testCwd = "";
let previousAgentDir: string | undefined;
let piDir = "";
let agentsDir = "";
let extensionsDir = "";
let matrixToolsExtension = "";
let subagentExtensionDir = "";
let subagentExtension = "";
let matrixAgentFile = "";
let matrixAgentNestedFile = "";

interface ExtensionRunnerLike {
	hasHandlers(event: "session_shutdown"): boolean;
	emit(event: { type: "session_shutdown" }): Promise<void> | void;
}

interface SessionLike {
	extensionRunner?: ExtensionRunnerLike;
	abort?: () => void;
	dispose?: () => void;
	getActiveToolNames?: () => unknown;
	agent?: { state?: { tools?: Array<{ name: string }> } };
}

interface AgentRecordLike {
	session?: SessionLike;
	status?: string;
	error?: unknown;
	promise?: Promise<unknown>;
}

interface SubagentManager {
	getRecord(id: string): AgentRecordLike | undefined;
}

let parentManager: SubagentManager | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSubagentManager(value: unknown): value is SubagentManager {
	return isRecord(value) && typeof value.getRecord === "function";
}

function getSubagentManager(): SubagentManager {
	const manager = parentManager ?? (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
	if (!isSubagentManager(manager)) throw new Error("Subagent manager was not registered");
	return manager;
}

function installRuntimeFixtures(): void {
	testCwd = mkdtempSync(path.join(tmpdir(), "pi-subagent-tool-access-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = path.join(testCwd, "agent-dir");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	piDir = path.join(testCwd, ".pi");
	agentsDir = path.join(agentDir, "agents");
	extensionsDir = path.join(piDir, "extensions");
	matrixToolsExtension = path.join(extensionsDir, "f3-matrix-tools.ts");
	subagentExtensionDir = path.join(extensionsDir, "f3-subagent");
	subagentExtension = path.join(subagentExtensionDir, "index.ts");
	matrixAgentFile = path.join(agentsDir, `${MATRIX_AGENT}.md`);
	matrixAgentNestedFile = path.join(agentsDir, `${MATRIX_AGENT_NESTED}.md`);

	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(subagentExtensionDir, { recursive: true });

	let subagentImport = path.relative(subagentExtensionDir, SUBAGENT_SOURCE).split(path.sep).join("/");
	if (!subagentImport.startsWith(".")) subagentImport = `./${subagentImport}`;
	writeFileSync(subagentExtension, `export { default } from ${JSON.stringify(subagentImport)};\n`);

	writeFileSync(
		matrixToolsExtension,
		`import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

function matrixTool(name: string) {
  return defineTool({
    name,
    label: name,
    description: \`F3 matrix probe tool \${name}.\`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }),
  });
}

export default function(pi: ExtensionAPI) {
  pi.registerTool(matrixTool("matrix.allowed"));
  pi.registerTool(matrixTool("matrix.denied"));
}
`,
	);

	writeFileSync(
		matrixAgentFile,
		`---
description: F3 tool matrix probe
builtin_tools: read
extensions: true
extension_tools: matrix.allowed, Agent, get_subagent_result, steer_subagent
---

Report the active tool matrix.
`,
	);

	writeFileSync(
		matrixAgentNestedFile,
		`---
description: F3 nested tool matrix probe
builtin_tools: read
extensions: true
extension_tools: matrix.allowed, Agent, get_subagent_result, steer_subagent
allow_nesting: true
---

Report the nested active tool matrix.
`,
	);
}

async function shutdownSession(session: SessionLike | undefined): Promise<void> {
	try {
		const runner = session?.extensionRunner;
		if (runner?.hasHandlers("session_shutdown")) {
			await runner.emit({ type: "session_shutdown" });
		}
	} catch (error) {
		void error; // Best-effort cleanup for harness sessions.
	}
	try { session?.abort?.(); } catch (error) { void error; }
	try { session?.dispose?.(); } catch (error) { void error; }
}

function cleanupRuntimeFixtures(): void {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	previousAgentDir = undefined;

	if (testCwd) rmSync(testCwd, { recursive: true, force: true });
	testCwd = "";
	piDir = "";
	agentsDir = "";
	extensionsDir = "";
	matrixToolsExtension = "";
	subagentExtensionDir = "";
	subagentExtension = "";
	matrixAgentFile = "";
	matrixAgentNestedFile = "";
}

async function spawnBackgroundAgent(t: TestSession, subagentType: string): Promise<string> {
	let agentId = "";
	await t.run(
		when(`Spawn ${subagentType}`, [
			calls("Agent", {
				prompt: "Stay idle long enough for the harness to inspect active tools.",
				description: `inspect ${subagentType}`,
				subagent_type: subagentType,
				run_in_background: true,
			}),
			says("Spawned."),
		]),
	);
	const resultText = t.events.toolResultsFor("Agent").at(-1)?.text ?? "";
	const match = resultText.match(/Agent ID: (\S+)/);
	if (match) agentId = match[1];
	if (!agentId) throw new Error(`Agent ID not found for ${subagentType}: ${resultText}`);
	return agentId;
}

async function waitForActiveTools(agentId: string): Promise<string[]> {
	const manager = getSubagentManager();
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const record = manager.getRecord(agentId);
		const session = record?.session;
		const activeTools = session?.getActiveToolNames?.();
		if (Array.isArray(activeTools) && activeTools.length > 0 && activeTools.every((tool): tool is string => typeof tool === "string")) {
			return activeTools;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	const record = manager.getRecord(agentId);
	throw new Error(`Timed out waiting for active tools for ${agentId}; status=${record?.status}; error=${record?.error}`);
}

async function abortSubagent(agentId: string): Promise<void> {
	const record = getSubagentManager().getRecord(agentId);
	await shutdownSession(record?.session);
	if (record?.promise) {
		await Promise.race([
			record.promise.catch(() => undefined),
			new Promise((resolve) => setTimeout(resolve, 1_000)),
		]);
	}
}

describe("subagent tool access — integration", () => {
	let t: TestSession | undefined;
	const spawnedIds: string[] = [];

	afterEach(async () => {
		for (const id of spawnedIds.splice(0)) {
			await abortSubagent(id);
		}
		await shutdownSession(t?.session);
		t?.dispose();
		t = undefined;
		parentManager = undefined;
		cleanupRuntimeFixtures();
	});

	it("applies custom-agent active-tool policy after extension binding", async () => {
		installRuntimeFixtures();
		t = await createTestSession({
			cwd: testCwd,
			propagateErrors: false,
		});
		parentManager = getSubagentManager();
		const parentTools = (t.session as SessionLike).agent?.state?.tools?.map((tool) => tool.name) ?? [];
		expect(parentTools).toContain("Agent");
		expect(parentTools).toContain("matrix.allowed");

		const nonNestedId = await spawnBackgroundAgent(t, MATRIX_AGENT);
		spawnedIds.push(nonNestedId);
		const nonNestedTools = await waitForActiveTools(nonNestedId);

		expect(nonNestedTools).toContain("read");
		expect(nonNestedTools).not.toContain("bash");
		expect(nonNestedTools).toContain("matrix.allowed");
		expect(nonNestedTools).not.toContain("matrix.denied");
		expect(nonNestedTools).not.toContain("Agent");
		expect(nonNestedTools).not.toContain("get_subagent_result");
		expect(nonNestedTools).not.toContain("steer_subagent");

		const nestedId = await spawnBackgroundAgent(t, MATRIX_AGENT_NESTED);
		spawnedIds.push(nestedId);
		const nestedTools = await waitForActiveTools(nestedId);

		expect(nestedTools).toContain("read");
		expect(nestedTools).not.toContain("bash");
		expect(nestedTools).toContain("matrix.allowed");
		expect(nestedTools).not.toContain("matrix.denied");
		expect(nestedTools).toContain("Agent");
		expect(nestedTools).toContain("get_subagent_result");
		expect(nestedTools).toContain("steer_subagent");
	});
});
