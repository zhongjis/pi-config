/**
 * subagent-tool-access-e2e.test.ts — Custom-agent active-tool policy against the
 * REAL pi-mono runtime, inspected at session construction.
 *
 * Mirrors the proven agent-runner-e2e / ext-templates-e2e pattern: a hermetic
 * $PI_CODING_AGENT_DIR holds the agent .md files plus two extensions (a matrix
 * tool probe and a re-export of the real subagents src). The agents are
 * loaded through the real `loadCustomAgents`, registered, then run headless via
 * `runAgent`. `onSessionCreated` fires after construction (before any prompt),
 * so `session.getActiveToolNames()` is exactly the gated set the LLM could call.
 *
 * No network, no background spawning, no manager: a native faux provider on a
 * per-test `ModelRuntime` satisfies `createAgentSession`; assertions read the
 * gated tool set the moment the session exists.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import type { AgentConfig } from "../src/types.js";
import { createFauxModelRuntime, type FauxModelRuntime } from "./helpers/pi-ai.js";

// These tests spin up the REAL pi-mono runtime (loader + dynamic extension
// import + session construction), so a cold first run under full-suite CPU
// contention can exceed vitest's 5s default. Give the file generous headroom.
vi.setConfig({ testTimeout: 30_000 });

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const SUBAGENT_SOURCE = path.join(PROJECT_ROOT, "extensions/subagents/src/index.ts");
const MATRIX_AGENT = "jintong";
const WENCHANG_AGENT = "wenchang";
const WENCHANG_SOURCE = path.join(PROJECT_ROOT, "agents/wenchang.md");

let testCwd = "";
let previousAgentDir: string | undefined;
let piDir = "";
let agentsDir = "";
let extensionsDir = "";
let matrixToolsExtension = "";
let subagentExtensionDir = "";
let subagentExtension = "";
let matrixAgentFile = "";

/** Minimal `pi` stub — `detectEnv` only needs `exec` (returns non-git). */
function makePi() {
	return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
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

	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(subagentExtensionDir, { recursive: true });

	let subagentImport = path.relative(subagentExtensionDir, SUBAGENT_SOURCE).split(path.sep).join("/");
	if (!subagentImport.startsWith(".")) subagentImport = `./${subagentImport}`;
	writeFileSync(subagentExtension, `export { default } from ${JSON.stringify(subagentImport)};\n`);

	writeFileSync(
		matrixToolsExtension,
		`import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  for (const name of ["web_search", "code_search", "fetch_content", "get_search_content", "mcporter", "mcp"]) {
    pi.registerTool(matrixTool(name));
  }
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

	writeFileSync(path.join(agentsDir, `${WENCHANG_AGENT}.md`), readFileSync(WENCHANG_SOURCE, "utf8"));
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
}

describe("subagent tool access — e2e (real pi-mono session + hermetic fixtures)", () => {
	let fauxRuntime: FauxModelRuntime;

	beforeEach(async () => {
		installRuntimeFixtures();
		fauxRuntime = await createFauxModelRuntime({
			provider: "faux",
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
	});

	afterEach(() => {
		fauxRuntime.dispose();
		cleanupRuntimeFixtures();
	});

	/**
	 * Load the hermetic agents through the REAL loader/registry, run `agentType`
	 * headless via runAgent, and return the live session's active tool names
	 * captured at construction (before any prompt turn).
	 */
	async function activeToolsFor(agentType: string): Promise<string[]> {
		const agents: Map<string, AgentConfig> = loadCustomAgents(testCwd);
		registerAgents(agents);
		const { model, modelRegistry } = fauxRuntime;
		const ctx: any = { cwd: testCwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

		let active: string[] = [];
		try {
			await runAgent(ctx, agentType, "go", {
				pi: makePi(),
				model,
				onSessionCreated: (s) => {
					active = s.getActiveToolNames();
				},
			});
		} catch {
			// A no-op/erroring prompt turn is fine — the gated tool set is fixed at
			// construction, which `onSessionCreated` already captured.
		}
		return active;
	}

	it("applies custom-agent active-tool policy after extension binding", async () => {
		const nonNestedTools = await activeToolsFor(MATRIX_AGENT);

		expect(nonNestedTools).toContain("read");
		expect(nonNestedTools).not.toContain("bash");
		expect(nonNestedTools).toContain("matrix.allowed");
		expect(nonNestedTools).not.toContain("matrix.denied");
		expect(nonNestedTools).not.toContain("Agent");
		expect(nonNestedTools).not.toContain("get_subagent_result");
		expect(nonNestedTools).not.toContain("steer_subagent");
	});

	it("gives the real Wen Chang agent access to mcporter", async () => {
		const wenchangTools = await activeToolsFor(WENCHANG_AGENT);

		expect(wenchangTools).toContain("read");
		expect(wenchangTools).toContain("web_search");
		expect(wenchangTools).toContain("code_search");
		expect(wenchangTools).toContain("fetch_content");
		expect(wenchangTools).toContain("get_search_content");
		expect(wenchangTools).toContain("mcporter");
		expect(wenchangTools).not.toContain("mcp");
		expect(wenchangTools).not.toContain("bash");
		expect(wenchangTools).not.toContain("edit");
		expect(wenchangTools).not.toContain("write");
		expect(wenchangTools).not.toContain("matrix.allowed");
		expect(wenchangTools).not.toContain("matrix.denied");
		expect(wenchangTools).not.toContain("Agent");
	});
});
