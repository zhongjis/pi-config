import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRegistry } from "../model.js";
import {
	BUILTIN_TOOL_MODELS_FILE,
	getToolModelSelection,
	loadToolModelsConfig,
	resolveToolModelSelection,
} from "../tool-models.js";

const SUMMARY_CHAIN = "gpt-5.4-mini,gemini-3-flash,claude-haiku-4-5,qwen3.5-plus,qwen2.5-coder:14b";
const COMMIT_CHAIN = "claude-haiku-4-5,gpt-5.4-mini,opencode-go/qwen3.5-plus,llama-swap/qwen2.5-coder:7b";
const GUARD_CHAIN = "openai-codex/gpt-5.6-luna:low,anthropic/claude-haiku-4-5";

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

function makeRegistry(available: Array<{ id: string; provider: string; name?: string }>): ModelRegistry {
	const models = available.map((model) => ({ name: model.name ?? model.id, ...model }));
	return {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models;
		},
	};
}

describe("tool model config", () => {
	let tempRoot = "";
	let agentDir = "";
	let cwd = "";
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "tool-models-test-"));
		agentDir = join(tempRoot, "agent");
		cwd = join(tempRoot, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { force: true, recursive: true });
	});

	it("loads built-in defaults", () => {
		const config = loadToolModelsConfig(cwd);

		expect(BUILTIN_TOOL_MODELS_FILE).toEqual({
			version: 1,
			roles: {
				"summary.session": SUMMARY_CHAIN,
				commit: COMMIT_CHAIN,
				"guard.tool": GUARD_CHAIN,
			},
			tools: {
				"smart-sessions.summary": { role: "summary.session" },
				"boomerang.commit": { role: "commit" },
				"smart-tool-guards.classifier": { role: "guard.tool" },
			},
		});
		expect(getToolModelSelection(config, "smart-sessions.summary")).toMatchObject({
			chain: SUMMARY_CHAIN,
			role: "summary.session",
			source: "built-in",
		});
		expect(getToolModelSelection(config, "boomerang.commit")).toMatchObject({
			chain: COMMIT_CHAIN,
			role: "commit",
			source: "built-in",
		});
		expect(getToolModelSelection(config, "smart-tool-guards.classifier")).toMatchObject({
			chain: GUARD_CHAIN,
			role: "guard.tool",
			source: "built-in",
		});
		expect(config.diagnostics).toEqual([]);
	});

	it("keeps the installed tool model chains resolvable and wires smart guard", () => {
		const installed = JSON.parse(readFileSync(join(process.cwd(), "tool_models.json"), "utf8"));

		expect(installed.roles["summary.session"].split(",")[0]).toBe("openai-codex/gpt-5.6-luna");
		expect(installed.roles.commit.split(",")[0]).toBe("openai-codex/gpt-5.6-luna");
		expect(installed.roles["guard.tool"]).toBe(GUARD_CHAIN);
		expect(installed.tools).toEqual({
			"smart-sessions.summary": { role: "summary.session" },
			"boomerang.commit": { role: "commit" },
			"smart-tool-guards.classifier": { role: "guard.tool" },
		});
	});

	it("lets project config override global config", () => {
		writeJson(join(agentDir, "tool_models.json"), {
			version: 1,
			roles: { commit: "global-model" },
		});
		writeJson(join(cwd, ".pi", "tool_models.json"), {
			version: 1,
			roles: { commit: "project-model" },
		});

		const config = loadToolModelsConfig(cwd);
		const selection = getToolModelSelection(config, "boomerang.commit");

		expect(selection).toMatchObject({ chain: "project-model", source: "project" });
	});

	it("replaces role chains atomically", () => {
		writeJson(join(cwd, ".pi", "tool_models.json"), {
			version: 1,
			roles: { "summary.session": "project-primary,project-fallback" },
		});

		const config = loadToolModelsConfig(cwd);
		const selection = getToolModelSelection(config, "smart-sessions.summary");

		expect(selection?.chain).toBe("project-primary,project-fallback");
		expect(selection?.candidates.map((candidate) => candidate.model)).toEqual([
			"project-primary",
			"project-fallback",
		]);
	});

	it("uses direct chains before role chains", () => {
		writeJson(join(cwd, ".pi", "tool_models.json"), {
			version: 1,
			roles: { "summary.session": "role-model" },
			tools: { "smart-sessions.summary": { chain: "direct-model" } },
		});

		const config = loadToolModelsConfig(cwd);
		const selection = getToolModelSelection(config, "smart-sessions.summary");

		expect(selection).toMatchObject({ chain: "direct-model", role: "summary.session", source: "project" });
	});

	it("lets null clear an inherited role", () => {
		writeJson(join(cwd, ".pi", "tool_models.json"), {
			version: 1,
			tools: { "smart-sessions.summary": { role: null } },
		});

		const config = loadToolModelsConfig(cwd);
		const selection = getToolModelSelection(config, "smart-sessions.summary");

		expect(selection).toBeUndefined();
		expect(config.diagnostics.at(-1)?.message).toContain("No role or chain configured");
	});

	it("keeps defaults and records diagnostics for invalid files", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tool_models.json"), "{ not json");

		const config = loadToolModelsConfig(cwd);
		const selection = getToolModelSelection(config, "smart-sessions.summary");

		expect(selection?.chain).toBe(SUMMARY_CHAIN);
		expect(config.diagnostics).toEqual([
			expect.objectContaining({ source: "project", path: join(cwd, ".pi", "tool_models.json") }),
		]);
	});

	it("diagnoses missing roles", () => {
		writeJson(join(cwd, ".pi", "tool_models.json"), {
			version: 1,
			tools: { "smart-sessions.summary": { role: "missing.role" } },
		});

		const config = loadToolModelsConfig(cwd);
		const selection = getToolModelSelection(config, "smart-sessions.summary");

		expect(selection).toBeUndefined();
		expect(config.diagnostics.at(-1)?.message).toBe("Tool model role not found for smart-sessions.summary: missing.role");
	});

	it("resolves the first available candidate through registry filtering", () => {
		const config = loadToolModelsConfig(cwd);
		const selection = getToolModelSelection(config, "smart-sessions.summary");
		const resolved = resolveToolModelSelection(
			selection,
			makeRegistry([{ id: "gemini-3-flash", provider: "google" }]),
		);

		expect(resolved?.model).toEqual({ id: "gemini-3-flash", name: "gemini-3-flash", provider: "google" });
	});
});
