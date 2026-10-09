/**
 * subagent-tool-access-e2e.test.ts — the signed-rule `extensions:` / `tools:`
 * contract against the REAL pi-mono runtime.
 *
 * A hermetic cwd holds synthetic agent .md files plus discovered project
 * extensions (a matrix tool probe, a re-export of the real subagents src, and
 * an extension that registers tools during `before_agent_start`). Agents load
 * through the real `loadCustomAgents`, are registered, then run headless via
 * `runAgent`. Assertions read the live session: loaded extension ids, the
 * active tool set at construction, the first provider request's declared
 * tools, and tool results.
 *
 * No network, no manager: a native faux provider on a per-test `ModelRuntime`
 * satisfies `createAgentSession`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionIdsForPath } from "../../lib/active-tools.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { createFauxModelRuntime, type FauxModelRuntime } from "./helpers/pi-ai.js";

// These tests spin up the REAL pi-mono runtime (loader + dynamic extension
// import + session construction), so a cold first run under full-suite CPU
// contention can exceed vitest's 5s default. Give the file generous headroom.
vi.setConfig({ testTimeout: 30_000 });

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const SUBAGENT_SOURCE = path.join(PROJECT_ROOT, "extensions/subagents/src/index.ts");
const CEILING = "subagent_tool_ceiling";

let testCwd = "";
let previousAgentDir: string | undefined;
let agentsDir = "";
let extensionsDir = "";

/** Minimal `pi` stub — `detectEnv` needs `exec` (returns non-git); MCP excludes read the parent catalog. */
function makePi() {
	return { exec: async () => ({ code: 1, stdout: "", stderr: "" }), getAllTools: () => [] } as any;
}

function installRuntimeFixtures(): void {
	testCwd = mkdtempSync(path.join(tmpdir(), "pi-subagent-tool-access-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = path.join(testCwd, "agent-dir");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	agentsDir = path.join(agentDir, "agents");
	extensionsDir = path.join(testCwd, ".pi", "extensions");
	const subagentExtensionDir = path.join(extensionsDir, "f3-subagent");
	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(subagentExtensionDir, { recursive: true });

	let subagentImport = path.relative(subagentExtensionDir, SUBAGENT_SOURCE).split(path.sep).join("/");
	if (!subagentImport.startsWith(".")) subagentImport = `./${subagentImport}`;
	writeFileSync(path.join(subagentExtensionDir, "index.ts"), `export { default } from ${JSON.stringify(subagentImport)};\n`);

	writeFileSync(
		path.join(extensionsDir, "f3-matrix-tools.ts"),
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
}
`,
	);

	// Registers its tools during before_agent_start, i.e. after the subagent's
	// scope was installed and inside the first prompt. Pi activates (declares)
	// newly registered direct tools, so only the ceiling can hide them.
	writeFileSync(
		path.join(extensionsDir, "late-tools.ts"),
		`import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function lateTool(name: string) {
  return defineTool({
    name,
    label: name,
    description: \`Late probe tool \${name}.\`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: \`\${name} ran\` }], details: {} }),
  });
}

export default function(pi: ExtensionAPI) {
  let registered = false;
  pi.on("before_agent_start", () => {
    if (registered) return;
    registered = true;
    pi.registerTool(lateTool("late.granted"));
    pi.registerTool(lateTool("late.ungranted"));
  });
}
`,
	);
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
	agentsDir = "";
	extensionsDir = "";
}

/** Write a synthetic agent definition with the given frontmatter lines. */
function writeAgent(name: string, frontmatter: string): void {
	writeFileSync(path.join(agentsDir, `${name}.md`), `---\ndescription: ${name} probe\n${frontmatter}\n---\n\nProbe.\n`);
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
	 * Load the hermetic agents through the REAL loader/registry and run
	 * `agentType` headless via runAgent. Returns the live session, the extension
	 * ids that loaded (trusted inline hooks excluded), and the active tool names
	 * captured at construction (before any prompt turn).
	 */
	async function run(agentType: string) {
		registerAgents(loadCustomAgents(testCwd));
		const { model, modelRegistry } = fauxRuntime;
		const ctx: any = { cwd: testCwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

		let session: AgentSession | undefined;
		let active: string[] = [];
		try {
			await runAgent(ctx, agentType, "go", {
				pi: makePi(),
				model,
				onSessionCreated: (s) => {
					session = s;
					active = s.getActiveToolNames();
				},
			});
		} catch {
			// A no-op/erroring prompt turn is fine — loading and the gated tool set
			// are fixed at construction, which `onSessionCreated` already captured.
		}
		if (!session) throw new Error(`no session created for ${agentType}`);
		const loaded = session.extensionRunner
			.getExtensionPaths()
			.filter((p) => !p.startsWith("<inline:"))
			.map((p) => extensionIdsForPath(p)[0])
			.sort();
		return { session, loaded, active };
	}

	it("applies custom-agent tool rules after extension binding", async () => {
		writeAgent("matrix", "extensions: +@all, -@builtin\ntools: +read, +matrix.allowed, +agent, +get_agent_result, +steer_subagent");
		const requests: string[][] = [];
		fauxRuntime.faux.setResponses([
			(context) => {
				requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage([fauxText("done")]);
			},
		]);

		const { active } = await run("matrix");

		// Pi activates every tool its loaded extensions register, including
		// matrix.denied, which the agent's `tools:` rules do not grant.
		expect(active).toContain("matrix.denied");
		// The model only ever sees what the rules grant — the ceiling hides the rest.
		expect(requests[0].filter((name) => name !== CEILING).sort()).toEqual(["matrix.allowed", "read"]);
	});

	it("omitted extensions: loads no discovered or built-in extension while tools: +read still activates read", async () => {
		writeAgent("bare", "tools: +read");

		const { loaded, active } = await run("bare");

		expect({ loaded, active }).toEqual({ loaded: [], active: ["read"] });
	});

	it("extensions: +@all loads the discovered fixtures plus Pi's built-in extensions", async () => {
		writeAgent("everything", "extensions: +@all\ntools: +read");

		const { loaded } = await run("everything");

		expect(loaded.filter((id) => !id.startsWith("builtin:"))).toEqual(["f3-matrix-tools", "f3-subagent", "late-tools"]);
		expect(loaded.some((id) => id.startsWith("builtin:"))).toBe(true);
	});

	it("extensions: +@all, -@builtin loads no builtin:* extension", async () => {
		writeAgent("discovered-only", "extensions: +@all, -@builtin\ntools: +read");

		const { loaded } = await run("discovered-only");

		expect(loaded).toEqual(["f3-matrix-tools", "f3-subagent", "late-tools"]);
	});

	it("tools: +@<extension>, -<tool> activates exactly the granted tools", async () => {
		writeAgent("group", "extensions: +f3-matrix-tools\ntools: +@f3-matrix-tools, -matrix.denied");
		const requests: string[][] = [];
		fauxRuntime.faux.setResponses([
			(context) => {
				requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage([fauxText("done")]);
			},
		]);

		const { active } = await run("group");

		// matrix.denied stays active (Pi activated it on registration); `-matrix.denied`
		// only permits, it does not deactivate.
		expect(active).toContain("matrix.denied");
		// The trusted ceiling tool is always granted and stays active; its own
		// declaration is hidden from the model, along with matrix.denied.
		expect(requests[0].sort()).toEqual(["matrix.allowed"]);
	});

	it("hides an ungranted tool registered during before_agent_start from the first provider request", async () => {
		writeAgent("late", "extensions: +late-tools\ntools: +read, +late.granted");
		const requests: string[][] = [];
		fauxRuntime.faux.setResponses([
			(context) => {
				requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage([fauxText("done")]);
			},
		]);

		await run("late");

		expect(requests[0].filter((name) => name.startsWith("late.")).sort()).toEqual(["late.granted"]);
	});

	it("vetoes a top-level call to an active but ungranted tool", async () => {
		writeAgent("veto", "extensions: +late-tools\ntools: +read");
		fauxRuntime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("late.ungranted", {})]),
			fauxAssistantMessage([fauxText("done")]),
		]);

		const { session } = await run("veto");

		const result = session.messages.find((m) => m.role === "toolResult" && m.toolName === "late.ungranted");
		expect(result).toMatchObject({
			isError: true,
			content: [{ type: "text", text: 'Tool "late.ungranted" is not available to this subagent.' }],
		});
	});

	it("fails the spawn when an extension id names more than one extension", async () => {
		writeFileSync(path.join(extensionsDir, "twin.ts"), "export default function() {}\n");
		mkdirSync(path.join(extensionsDir, "twin"));
		writeFileSync(path.join(extensionsDir, "twin", "index.ts"), "export default function() {}\n");
		writeAgent("ambiguous", "extensions: +twin\ntools: +read");
		registerAgents(loadCustomAgents(testCwd));
		const { model, modelRegistry } = fauxRuntime;
		const ctx: any = { cwd: testCwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

		await expect(runAgent(ctx, "ambiguous", "go", { pi: makePi(), model })).rejects.toThrow(/"twin" is ambiguous/);
	});
});
