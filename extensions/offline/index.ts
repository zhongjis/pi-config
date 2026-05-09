import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "../lib/model.js";

export interface OfflineConfig {
	enabled: boolean;
	localProviders: string[];
	defaultModel: string;
	agentModels: Record<string, string>;
	blockedAgents: string[];
	blockedTools: string[];
	notifyOnSessionStart: boolean;
	statusText: string;
}

type PartialOfflineConfig = Partial<OfflineConfig>;
type ModelLike = { id: string; provider: string; name?: string };
type ModelRegistryLike = {
	find?: (provider: string, modelId: string) => unknown;
	getAll?: () => ModelLike[];
	getAvailable?: () => ModelLike[];
};

type Notify = (message: string, type: "info" | "warning" | "error") => void;

const NOTIFICATION_TEXT = "Offline mode enabled: local models only; web tools and wenchang disabled.";

export const OFFLINE_SYSTEM_PROMPT = `Offline mode is ON.

Constraints:
- Assume no internet access.
- Use only local files, local tools, and local models.
- Do not delegate to wenchang.
- Do not call web, search, or fetch tools.
- Do not suggest online documentation unless the user asks to leave offline mode.
- If external information is missing, state what local evidence is missing and proceed from repo files, local docs, and cached context.`;

export const DEFAULT_OFFLINE_CONFIG: OfflineConfig = {
	enabled: false,
	localProviders: ["llama-swap"],
	defaultModel: "llama-swap/qwen3.6:27b",
	agentModels: {
		chengfeng: "llama-swap/qwen2.5-coder:7b",
		guangguang: "llama-swap/qwen2.5-coder:7b",
		jintong: "llama-swap/qwen3.6:27b",
		kuafu: "llama-swap/qwen3.6:27b",
		luban: "llama-swap/qwen3.6:27b",
		houtu: "llama-swap/qwen3.6:27b",
		fuxi: "llama-swap/gemma4:31b",
		taishang: "llama-swap/gemma4:31b",
		direnjie: "llama-swap/gemma4:26b",
		yanluo: "llama-swap/gemma4:26b",
		weizheng: "llama-swap/gemma4:26b",
		yunu: "llama-swap/gemma4:31b",
	},
	blockedAgents: ["wenchang"],
	blockedTools: ["web_search", "code_search", "fetch_content", "get_search_content"],
	notifyOnSessionStart: true,
	statusText: "offline: llama-swap",
};

const originalGetAvailableByRegistry = new WeakMap<object, ModelRegistryLike["getAvailable"]>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return strings.length === value.length ? strings : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return entries.length === Object.keys(value).length ? Object.fromEntries(entries) : undefined;
}

function sanitizeConfig(value: unknown): PartialOfflineConfig {
	if (!isRecord(value)) return {};
	const next: PartialOfflineConfig = {};

	if (typeof value.enabled === "boolean") next.enabled = value.enabled;
	if (typeof value.defaultModel === "string") next.defaultModel = value.defaultModel;
	if (typeof value.notifyOnSessionStart === "boolean") next.notifyOnSessionStart = value.notifyOnSessionStart;
	if (typeof value.statusText === "string") next.statusText = value.statusText;

	const localProviders = stringArray(value.localProviders);
	if (localProviders) next.localProviders = localProviders;

	const blockedAgents = stringArray(value.blockedAgents);
	if (blockedAgents) next.blockedAgents = blockedAgents;

	const blockedTools = stringArray(value.blockedTools);
	if (blockedTools) next.blockedTools = blockedTools;

	const agentModels = stringMap(value.agentModels);
	if (agentModels) next.agentModels = agentModels;

	return next;
}

function mergeConfig(base: OfflineConfig, override: PartialOfflineConfig): OfflineConfig {
	return {
		...base,
		...override,
		localProviders: override.localProviders ?? base.localProviders,
		blockedAgents: override.blockedAgents ?? base.blockedAgents,
		blockedTools: override.blockedTools ?? base.blockedTools,
		agentModels: {
			...base.agentModels,
			...(override.agentModels ?? {}),
		},
	};
}

function readConfig(path: string, notify?: Notify): PartialOfflineConfig {
	if (!existsSync(path)) return {};
	try {
		return sanitizeConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify?.(`Offline mode: failed to read ${path}: ${message}`, "error");
		return {};
	}
}

export function loadOfflineConfig(cwd: string, notify?: Notify): OfflineConfig {
	const globalPath = join(homedir(), ".pi", "agent", "offline.json");
	const projectPath = join(cwd, ".pi", "offline.json");
	return mergeConfig(mergeConfig(DEFAULT_OFFLINE_CONFIG, readConfig(globalPath, notify)), readConfig(projectPath, notify));
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

function isLocalProvider(provider: string | undefined, config: OfflineConfig): boolean {
	if (!provider) return false;
	const localProviders = new Set(config.localProviders.map(normalize));
	return localProviders.has(normalize(provider));
}

function isSameModel(a: unknown, b: unknown): boolean {
	const left = a as { id?: unknown; provider?: unknown } | undefined;
	const right = b as { id?: unknown; provider?: unknown } | undefined;
	return Boolean(left?.id && right?.id && left.id === right.id && left.provider === right.provider);
}

function findConfigModel(modelName: string, registry: ModelRegistryLike): unknown | undefined {
	const resolved = resolveModel(modelName, registry as never);
	return typeof resolved === "string" ? undefined : resolved;
}

function findFirstLocalModel(registry: ModelRegistryLike, config: OfflineConfig): unknown | undefined {
	const available = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
	return available.find((model) => isLocalProvider(model.provider, config));
}

async function setModel(pi: ExtensionAPI, model: unknown, notify?: Notify): Promise<boolean> {
	const ok = await pi.setModel(model as never);
	if (ok === false) {
		const typed = model as { provider?: string; id?: string };
		notify?.(`Offline mode: local model unavailable: ${typed.provider ?? "unknown"}/${typed.id ?? "unknown"}`, "error");
		return false;
	}
	return true;
}

export async function forceLocalModel(pi: ExtensionAPI, ctx: ExtensionContext, config: OfflineConfig, notify?: Notify): Promise<void> {
	if (isLocalProvider(ctx.model?.provider, config)) return;
	const target = findConfigModel(config.defaultModel, ctx.modelRegistry) ?? findFirstLocalModel(ctx.modelRegistry, config);
	if (!target) {
		notify?.(`Offline mode: no local model available for providers: ${config.localProviders.join(", ")}`, "error");
		return;
	}
	await setModel(pi, target, notify);
}

export function installModelRegistryFilter(
	registry: ModelRegistryLike,
	isActive: () => boolean,
	getConfig: () => OfflineConfig,
): void {
	if (!registry || typeof registry !== "object" || typeof registry.getAvailable !== "function") return;
	if (!originalGetAvailableByRegistry.has(registry)) {
		originalGetAvailableByRegistry.set(registry, registry.getAvailable);
	}
	const original = originalGetAvailableByRegistry.get(registry);
	if (!original) return;

	registry.getAvailable = function getOfflineAvailable(this: ModelRegistryLike): ModelLike[] {
		const available = original.call(this) ?? [];
		if (!isActive()) return available;
		const config = getConfig();
		return available.filter((model) => isLocalProvider(model.provider, config));
	};
}

function isOfflineActive(pi: ExtensionAPI, config: OfflineConfig, manualOverride: boolean | undefined): boolean {
	if (manualOverride !== undefined) return manualOverride;
	const flag = pi.getFlag("offline-mode");
	return flag === true || flag === "true" || process.env.PI_AGENT_OFFLINE_MODE === "1" || config.enabled;
}

function offlineStatus(config: OfflineConfig, active: boolean): string {
	return active ? `on (${config.statusText})` : "off";
}

function appendOfflinePrompt(systemPrompt: string): string {
	if (systemPrompt.includes(OFFLINE_SYSTEM_PROMPT)) return systemPrompt;
	return systemPrompt.trimEnd() ? `${systemPrompt.trimEnd()}\n\n${OFFLINE_SYSTEM_PROMPT}` : OFFLINE_SYSTEM_PROMPT;
}

export default function offlineExtension(pi: ExtensionAPI): void {
	let config = DEFAULT_OFFLINE_CONFIG;
	let active = false;
	let manualOverride: boolean | undefined;
	let notifiedSessionStart = false;
	const notifiedErrors = new Set<string>();
	const temporaryAgentModels = new Map<string, { previousModel: unknown; temporaryModel: unknown }>();

	function notifyOnce(ctx: ExtensionContext, key: string, message: string, type: "info" | "warning" | "error" = "info"): void {
		if (notifiedErrors.has(key)) return;
		notifiedErrors.add(key);
		ctx.ui.notify(message, type);
	}

	function refreshState(ctx: ExtensionContext): void {
		config = loadOfflineConfig(ctx.cwd, (message, type) => notifyOnce(ctx, `config:${message}`, message, type));
		active = isOfflineActive(pi, config, manualOverride);
		installModelRegistryFilter(ctx.modelRegistry, () => active, () => config);
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("offline", active ? config.statusText : undefined);
	}

	async function applyOffline(ctx: ExtensionContext): Promise<void> {
		refreshState(ctx);
		updateStatus(ctx);
		if (!active) return;
		await forceLocalModel(pi, ctx, config, (message, type) => notifyOnce(ctx, `model:${message}`, message, type));
	}

	pi.registerFlag("offline-mode", {
		description: "Enable offline mode: local models only; web tools and wenchang disabled",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("offline", {
		description: "Control offline mode (on/off/status)",
		getArgumentCompletions: (prefix: string) => {
			const query = prefix.trim().toLowerCase();
			return ["on", "off", "status"].filter((item) => item.startsWith(query)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on") {
				manualOverride = true;
				await applyOffline(ctx);
				ctx.ui.notify(`Offline mode ${offlineStatus(config, active)}`, "info");
				return;
			}
			if (action === "off") {
				manualOverride = false;
				await applyOffline(ctx);
				ctx.ui.notify("Offline mode off", "info");
				return;
			}
			if (action === "status") {
				refreshState(ctx);
				updateStatus(ctx);
				ctx.ui.notify(`Offline mode ${offlineStatus(config, active)}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /offline on|off|status", "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await applyOffline(ctx);
		if (active && config.notifyOnSessionStart && !notifiedSessionStart) {
			ctx.ui.notify(NOTIFICATION_TEXT, "info");
			notifiedSessionStart = true;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await applyOffline(ctx);
		if (!active) return;
		return { systemPrompt: appendOfflinePrompt(event.systemPrompt) };
	});

	pi.on("tool_call", async (event, ctx) => {
		refreshState(ctx);
		if (!active) return;

		if (config.blockedTools.map(normalize).includes(normalize(event.toolName))) {
			return {
				block: true,
				reason: `Offline mode: tool "${event.toolName}" is disabled because it requires web access.`,
			};
		}

		if (event.toolName !== "Agent") return;

		const requestedType = typeof event.input.subagent_type === "string" ? event.input.subagent_type : "";
		if (config.blockedAgents.map(normalize).includes(normalize(requestedType))) {
			return {
				block: true,
				reason: `Offline mode: delegation to "${requestedType}" is disabled.`,
			};
		}

		const agentModel = config.agentModels[requestedType] ?? config.agentModels[normalize(requestedType)];
		if (!agentModel) return;

		const temporaryModel = findConfigModel(agentModel, ctx.modelRegistry);
		if (!temporaryModel || !isLocalProvider((temporaryModel as { provider?: string }).provider, config)) {
			notifyOnce(ctx, `agent-model:${requestedType}`, `Offline mode: configured model for ${requestedType} is unavailable: ${agentModel}`, "error");
			return;
		}

		temporaryAgentModels.set(event.toolCallId, {
			previousModel: ctx.model,
			temporaryModel,
		});
		await setModel(pi, temporaryModel, (message, type) => notifyOnce(ctx, `agent-set:${message}`, message, type));
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "Agent") return;
		const pending = temporaryAgentModels.get(event.toolCallId);
		if (!pending) return;
		temporaryAgentModels.delete(event.toolCallId);

		refreshState(ctx);
		if (!active) return;
		const previous = pending.previousModel as { provider?: string } | undefined;
		if (previous && isLocalProvider(previous.provider, config) && (isSameModel(ctx.model, pending.temporaryModel) || isSameModel(ctx.model, previous) || !ctx.model)) {
			await setModel(pi, previous, (message, type) => notifyOnce(ctx, `agent-restore:${message}`, message, type));
			return;
		}
		await forceLocalModel(pi, ctx, config, (message, type) => notifyOnce(ctx, `agent-force:${message}`, message, type));
	});
}
