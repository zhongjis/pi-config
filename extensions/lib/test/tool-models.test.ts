import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRegistry } from "../model-selection.js";
import {
	BUILTIN_TOOL_MODELS_FILE,
	getToolModelSelection,
	loadToolModelsConfig,
	resolveToolModelChain,
	resolveToolModelCandidates,
	resolveToolModelSelection,
} from "../tool-models.js";

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeSummaryChain(agentDir: string): void {
	writeJson(join(agentDir, "tool_models.json"), {
		version: 1,
		roles: { "summary.session": "fixture/missing,fixture/summary" },
	});
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

		for (const [tool, mapping] of Object.entries(BUILTIN_TOOL_MODELS_FILE.tools)) {
			const role = mapping.role;
			expect(getToolModelSelection(config, tool)).toMatchObject({
				chain: BUILTIN_TOOL_MODELS_FILE.roles[role],
				role,
				source: "built-in",
			});
		}
		expect(config.diagnostics).toEqual([]);
	});

	it("resolves configured role chains through known tool wiring", () => {
		writeJson(join(agentDir, "tool_models.json"), {
			version: 1,
			roles: {
				"summary.session": "fixture/missing-summary,fixture/summary:low:fast",
				commit: "fixture/missing-commit,fixture/commit:medium",
				"guard.tool": "fixture/missing-guard,fixture/guard:high",
				"vision.inspect": "fixture/missing-vision,fixture/vision:medium",
			},
		});
		const registry = makeRegistry([
			{ provider: "fixture", id: "summary" },
			{ provider: "fixture", id: "commit" },
			{ provider: "fixture", id: "guard" },
			{ provider: "fixture", id: "vision" },
		]);
		const config = loadToolModelsConfig(cwd);
		const expectations = [
			{ tool: "smart-sessions.summary", role: "summary.session", id: "summary", thinkingLevel: "low", fast: true },
			{ tool: "boomerang.commit", role: "commit", id: "commit", thinkingLevel: "medium" },
			{ tool: "smart-tool-guards.classifier", role: "guard.tool", id: "guard", thinkingLevel: "high" },
			{ tool: "multimodal-look.inspect", role: "vision.inspect", id: "vision", thinkingLevel: "medium" },
		];
		for (const { tool, role, id, ...metadata } of expectations) {
			const selection = getToolModelSelection(config, tool);
			expect(selection).toMatchObject({ toolKey: tool, role, source: "global" });
			expect(resolveToolModelSelection(selection, registry)).toEqual({
				model: { provider: "fixture", id, name: id },
				...metadata,
			});
		}
		expect(config.diagnostics).toEqual([]);
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

		expect(selection?.chain).toBe(BUILTIN_TOOL_MODELS_FILE.roles["summary.session"]);
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
		writeSummaryChain(agentDir);
		const config = loadToolModelsConfig(cwd);
		const selection = getToolModelSelection(config, "smart-sessions.summary");
		const resolved = resolveToolModelSelection(
			selection,
			makeRegistry([{ id: "summary", provider: "fixture" }]),
		);

		expect(resolved?.model).toEqual({ id: "summary", name: "summary", provider: "fixture" });
	});

	it("orders candidates: chain model then ctx.model fallback", () => {
		writeSummaryChain(agentDir);
		const registry = makeRegistry([{ id: "summary", provider: "fixture" }]);
		const ctxModel = { id: "session-model", provider: "session" };
		const result = resolveToolModelCandidates(
			{ cwd, modelRegistry: registry, model: ctxModel },
			"smart-sessions.summary",
		);

		expect(result.candidates.map((candidate) => candidate.model)).toEqual([
			{ id: "summary", name: "summary", provider: "fixture" },
			ctxModel,
		]);
		expect(result.chain).toBe("fixture/missing,fixture/summary");
	});

	it("falls back to ctx.model when the chain has no available model", () => {
		const registry = makeRegistry([]);
		const ctxModel = { id: "session-model", provider: "session" };
		const result = resolveToolModelCandidates(
			{ cwd, modelRegistry: registry, model: ctxModel },
			"smart-sessions.summary",
		);

		expect(result.candidates.map((candidate) => candidate.model)).toEqual([ctxModel]);
	});

	it("uses only the chain model when no ctx.model is present", () => {
		writeSummaryChain(agentDir);
		const registry = makeRegistry([{ id: "summary", provider: "fixture" }]);
		const result = resolveToolModelCandidates(
			{ cwd, modelRegistry: registry },
			"smart-sessions.summary",
		);

		expect(result.candidates.map((candidate) => candidate.model)).toEqual([
			{ id: "summary", name: "summary", provider: "fixture" },
		]);
	});

	it("yields no candidates when neither chain nor ctx.model resolves", () => {
		const registry = makeRegistry([]);
		const result = resolveToolModelCandidates(
			{ cwd, modelRegistry: registry },
			"smart-sessions.summary",
		);

		expect(result.candidates).toEqual([]);
	});

	it("resolveToolModelChain returns every entry in written order without filtering or session fallback", () => {
		writeSummaryChain(agentDir);
		const result = resolveToolModelChain(cwd, "smart-sessions.summary");

		expect(result.entries.map((entry) => entry.model)).toEqual([
			"fixture/missing",
			"fixture/summary",
		]);
		expect(result.chain).toBe("fixture/missing,fixture/summary");
	});

	it("resolveToolModelChain lets a project direct chain win", () => {
		writeSummaryChain(agentDir);
		writeJson(join(cwd, ".pi", "tool_models.json"), {
			version: 1,
			tools: { "smart-sessions.summary": { chain: "fixture/b,fixture/a" } },
		});
		const result = resolveToolModelChain(cwd, "smart-sessions.summary");

		expect(result.entries.map((entry) => entry.model)).toEqual(["fixture/b", "fixture/a"]);
	});

	it("resolveToolModelChain yields no entries for a cleared tool", () => {
		writeJson(join(cwd, ".pi", "tool_models.json"), {
			version: 1,
			tools: { "smart-sessions.summary": null },
		});

		expect(resolveToolModelChain(cwd, "smart-sessions.summary")).toEqual({ entries: [], chain: undefined });
	});
});
