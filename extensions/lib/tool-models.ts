import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseModelChain, resolveFirstAvailable } from "./model.js";
import type { ModelCandidate, ModelRegistry } from "./model.js";

export interface ToolModelRuleFile {
	role?: string | null;
	chain?: string | null;
}

export interface ToolModelsFile {
	version: 1;
	roles?: Record<string, string | null>;
	tools?: Record<string, ToolModelRuleFile | null>;
}

export type ToolModelsSource = "built-in" | "global" | "project";

export interface ToolModelsDiagnostic {
	level: "warning" | "error";
	message: string;
	source: ToolModelsSource;
	path?: string;
}

interface ToolModelRoleConfig {
	chain: string;
	candidates: ModelCandidate[];
	source: ToolModelsSource;
	path?: string;
}

interface ToolModelRuleConfig {
	role?: string;
	roleSource?: ToolModelsSource;
	rolePath?: string;
	chain?: string;
	chainCandidates?: ModelCandidate[];
	chainSource?: ToolModelsSource;
	chainPath?: string;
	source?: ToolModelsSource;
	path?: string;
}

export interface ToolModelsConfig {
	roles: Record<string, ToolModelRoleConfig>;
	tools: Record<string, ToolModelRuleConfig>;
	diagnostics: ToolModelsDiagnostic[];
}

export interface ToolModelSelection {
	toolKey: string;
	role?: string;
	chain: string;
	candidates: ModelCandidate[];
	source: ToolModelsSource;
	path?: string;
}

export const BUILTIN_TOOL_MODELS_FILE: ToolModelsFile = {
	version: 1,
	roles: {
		"summary.session": "gpt-5.4-mini,gemini-3-flash,claude-haiku-4-5,qwen3.5-plus,qwen2.5-coder:14b",
		commit: "claude-haiku-4-5,gpt-5.4-mini,opencode-go/qwen3.5-plus,llama-swap/qwen2.5-coder:7b",
		"guard.tool": "openai-codex/gpt-5.6-luna:low,anthropic/claude-haiku-4-5",
	},
	tools: {
		"smart-sessions.summary": { role: "summary.session" },
		"boomerang.commit": { role: "commit" },
		"smart-tool-guards.classifier": { role: "guard.tool" },
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(
	config: ToolModelsConfig,
	source: ToolModelsSource,
	message: string,
	path?: string,
): void {
	config.diagnostics.push({ level: "error", message, source, path });
}

function createEmptyConfig(): ToolModelsConfig {
	return { roles: {}, tools: {}, diagnostics: [] };
}

function parseToolModelsFile(
	value: unknown,
	config: ToolModelsConfig,
	source: ToolModelsSource,
	path?: string,
): ToolModelsFile | undefined {
	if (!isRecord(value)) {
		diagnostic(config, source, "tool_models.json must be an object", path);
		return undefined;
	}
	if (value.version !== 1) {
		diagnostic(config, source, "tool_models.json version must be 1", path);
		return undefined;
	}

	const roles = value.roles;
	if (roles !== undefined && !isRecord(roles)) {
		diagnostic(config, source, "tool_models.json roles must be an object", path);
		return undefined;
	}
	let parsedRoles: Record<string, string | null> | undefined;
	if (isRecord(roles)) {
		parsedRoles = {};
		for (const [name, chain] of Object.entries(roles)) {
			if (!name || (typeof chain !== "string" && chain !== null)) {
				diagnostic(config, source, "tool_models.json roles values must be strings or null", path);
				return undefined;
			}
			parsedRoles[name] = typeof chain === "string" ? chain : null;
		}
	}

	const tools = value.tools;
	if (tools !== undefined && !isRecord(tools)) {
		diagnostic(config, source, "tool_models.json tools must be an object", path);
		return undefined;
	}
	let parsedTools: Record<string, ToolModelRuleFile | null> | undefined;
	if (isRecord(tools)) {
		parsedTools = {};
		for (const [toolKey, rule] of Object.entries(tools)) {
			if (rule === null) {
				parsedTools[toolKey] = null;
				continue;
			}
			if (!isRecord(rule)) {
				diagnostic(config, source, "tool_models.json tool rules must be objects or null", path);
				return undefined;
			}
			for (const key of Object.keys(rule)) {
				if (key !== "role" && key !== "chain") {
					diagnostic(config, source, `tool_models.json tool rule has unsupported key: ${key}`, path);
					return undefined;
				}
			}
			const parsedRule: ToolModelRuleFile = {};
			if ("role" in rule) {
				const role = rule.role;
				if (typeof role !== "string" && role !== null) {
					diagnostic(config, source, "tool_models.json tool rule role must be a string or null", path);
					return undefined;
				}
				parsedRule.role = typeof role === "string" ? role : null;
			}
			if ("chain" in rule) {
				const chain = rule.chain;
				if (typeof chain !== "string" && chain !== null) {
					diagnostic(config, source, "tool_models.json tool rule chain must be a string or null", path);
					return undefined;
				}
				parsedRule.chain = typeof chain === "string" ? chain : null;
			}
			parsedTools[toolKey] = parsedRule;
		}
	}

	const parsedFile: ToolModelsFile = { version: 1 };
	if (parsedRoles !== undefined) parsedFile.roles = parsedRoles;
	if (parsedTools !== undefined) parsedFile.tools = parsedTools;
	return parsedFile;
}

function applyToolModelsFile(
	config: ToolModelsConfig,
	file: ToolModelsFile,
	source: ToolModelsSource,
	path?: string,
): void {
	for (const [role, chain] of Object.entries(file.roles ?? {})) {
		if (chain === null) {
			delete config.roles[role];
			continue;
		}
		config.roles[role] = {
			chain,
			candidates: parseModelChain(chain),
			source,
			path,
		};
	}

	for (const [toolKey, rule] of Object.entries(file.tools ?? {})) {
		if (rule === null) {
			config.tools[toolKey] = { source, path };
			continue;
		}

		const next: ToolModelRuleConfig = { ...(config.tools[toolKey] ?? {}) };
		next.source = source;
		next.path = path;

		if ("role" in rule) {
			if (rule.role === null) {
				delete next.role;
				delete next.roleSource;
				delete next.rolePath;
			} else {
				next.role = rule.role;
				next.roleSource = source;
				next.rolePath = path;
			}
		}

		if ("chain" in rule) {
			const chain = rule.chain;
			if (chain === null) {
				delete next.chain;
				delete next.chainCandidates;
				delete next.chainSource;
				delete next.chainPath;
			} else if (chain !== undefined) {
				next.chain = chain;
				next.chainCandidates = parseModelChain(chain);
				next.chainSource = source;
				next.chainPath = path;
			}
		}

		config.tools[toolKey] = next;
	}
}

function loadFile(
	path: string,
	config: ToolModelsConfig,
	source: Exclude<ToolModelsSource, "built-in">,
): ToolModelsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parseToolModelsFile(parsed, config, source, path);
	} catch (error) {
		diagnostic(config, source, `Failed to parse tool_models.json: ${String(error)}`, path);
		return undefined;
	}
}

export function loadToolModelsConfig(cwd: string): ToolModelsConfig {
	const config = createEmptyConfig();
	applyToolModelsFile(config, BUILTIN_TOOL_MODELS_FILE, "built-in");

	const globalPath = join(getAgentDir(), "tool_models.json");
	const globalFile = loadFile(globalPath, config, "global");
	if (globalFile) applyToolModelsFile(config, globalFile, "global", globalPath);

	const projectPath = join(cwd, ".pi", "tool_models.json");
	const projectFile = loadFile(projectPath, config, "project");
	if (projectFile) applyToolModelsFile(config, projectFile, "project", projectPath);

	return config;
}

export function getToolModelSelection(
	config: ToolModelsConfig,
	toolKey: string,
): ToolModelSelection | undefined {
	const rule = config.tools[toolKey];
	if (!rule) {
		diagnostic(config, "built-in", `No tool model rule configured for ${toolKey}`);
		return undefined;
	}

	if (rule.chain !== undefined) {
		const candidates = rule.chainCandidates ?? parseModelChain(rule.chain);
		if (candidates.length === 0) {
			diagnostic(config, rule.chainSource ?? rule.source ?? "built-in", `Tool model chain is empty for ${toolKey}`, rule.chainPath ?? rule.path);
			return undefined;
		}
		return {
			toolKey,
			role: rule.role,
			chain: rule.chain,
			candidates,
			source: rule.chainSource ?? rule.source ?? "built-in",
			path: rule.chainPath ?? rule.path,
		};
	}

	if (!rule.role) {
		diagnostic(config, rule.source ?? "built-in", `No role or chain configured for ${toolKey}`, rule.path);
		return undefined;
	}

	const role = config.roles[rule.role];
	if (!role) {
		diagnostic(config, rule.roleSource ?? rule.source ?? "built-in", `Tool model role not found for ${toolKey}: ${rule.role}`, rule.rolePath ?? rule.path);
		return undefined;
	}
	if (role.candidates.length === 0) {
		diagnostic(config, role.source, `Tool model role chain is empty for ${rule.role}`, role.path);
		return undefined;
	}

	return {
		toolKey,
		role: rule.role,
		chain: role.chain,
		candidates: role.candidates,
		source: role.source,
		path: role.path,
	};
}

export function resolveToolModelSelection(
	selection: ToolModelSelection | undefined,
	registry: ModelRegistry,
): { model: any; thinkingLevel?: ModelCandidate["thinkingLevel"] } | undefined {
	if (!selection) return undefined;
	return resolveFirstAvailable(selection.candidates, registry);
}
