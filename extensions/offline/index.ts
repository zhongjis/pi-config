import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "../lib/model.js";

export interface OfflineConfig {
	localProviders: string[];
	defaultModel: string;
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

export const OFFLINE_STATE_CUSTOM_TYPE = "panda:offline-mode";

type OfflineState = { active: boolean };
type SessionEntryLike = { type?: string; customType?: string; data?: unknown };
type RegistryPolicy = {
	activeConfigs: Map<symbol, OfflineConfig>;
	originalGetAvailable?: ModelRegistryLike["getAvailable"];
};

type SessionContext = ExtensionContext & {
	sessionManager?: { getEntries?: () => unknown[] };
};

type OfflineExtensionAPI = ExtensionAPI & {
	appendEntry?: (customType: string, data: unknown) => void;
};

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
	localProviders: ["llama-swap"],
	defaultModel: "llama-swap/qwen3.6:27b",
	blockedAgents: ["wenchang"],
	blockedTools: ["web_search", "code_search", "fetch_content", "get_search_content"],
	notifyOnSessionStart: true,
	statusText: "offline: llama-swap",
};

const registryPolicies = new WeakMap<object, RegistryPolicy>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return strings.length === value.length ? strings : undefined;
}

function sanitizeConfig(value: unknown, path: string, notify?: Notify): PartialOfflineConfig {
	if (!isRecord(value)) return {};
	const next: PartialOfflineConfig = {};

	if ("enabled" in value) {
		notify?.(`Offline mode: ignoring ${path}: enabled is no longer supported; use /offline on`, "warning");
	}
	if ("agentModels" in value) {
		notify?.(`Offline mode: ignoring ${path}: agentModels is no longer supported; use subagent model fallback`, "warning");
	}

	if (typeof value.defaultModel === "string") next.defaultModel = value.defaultModel;
	else if ("defaultModel" in value) notify?.(`Offline mode: ignoring invalid defaultModel in ${path}`, "warning");

	if (typeof value.notifyOnSessionStart === "boolean") next.notifyOnSessionStart = value.notifyOnSessionStart;
	else if ("notifyOnSessionStart" in value) notify?.(`Offline mode: ignoring invalid notifyOnSessionStart in ${path}`, "warning");

	if (typeof value.statusText === "string") next.statusText = value.statusText;
	else if ("statusText" in value) notify?.(`Offline mode: ignoring invalid statusText in ${path}`, "warning");

	const localProviders = stringArray(value.localProviders);
	if (localProviders) next.localProviders = localProviders;
	else if ("localProviders" in value) notify?.(`Offline mode: ignoring invalid localProviders in ${path}`, "warning");

	const blockedAgents = stringArray(value.blockedAgents);
	if (blockedAgents) next.blockedAgents = blockedAgents;
	else if ("blockedAgents" in value) notify?.(`Offline mode: ignoring invalid blockedAgents in ${path}`, "warning");

	const blockedTools = stringArray(value.blockedTools);
	if (blockedTools) next.blockedTools = blockedTools;
	else if ("blockedTools" in value) notify?.(`Offline mode: ignoring invalid blockedTools in ${path}`, "warning");

	return next;
}

function mergeConfig(base: OfflineConfig, override: PartialOfflineConfig): OfflineConfig {
	return {
		...base,
		...override,
		localProviders: override.localProviders ?? base.localProviders,
		blockedAgents: override.blockedAgents ?? base.blockedAgents,
		blockedTools: override.blockedTools ?? base.blockedTools,
	};
}

function isOfflineState(value: unknown): value is OfflineState {
	return isRecord(value) && typeof value.active === "boolean";
}

function readSessionOfflineState(ctx: ExtensionContext): boolean | undefined {
	const entries = ((ctx as SessionContext).sessionManager?.getEntries?.() ?? []) as SessionEntryLike[];
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== OFFLINE_STATE_CUSTOM_TYPE) continue;
		if (isOfflineState(entry.data)) return entry.data.active;
	}
	return undefined;
}

function writeSessionOfflineState(pi: ExtensionAPI, active: boolean): void {
	(pi as OfflineExtensionAPI).appendEntry?.(OFFLINE_STATE_CUSTOM_TYPE, { active });
}

function readConfig(path: string, notify?: Notify): PartialOfflineConfig {
	if (!existsSync(path)) return {};
	try {
		return sanitizeConfig(JSON.parse(readFileSync(path, "utf-8")), path, notify);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify?.(`Offline mode: failed to read ${path}: ${message}`, "error");
		return {};
	}
}

export function loadOfflineConfig(cwd: string, notify?: Notify): OfflineConfig {
	const projectPath = join(cwd, ".pi", "offline.json");
	return mergeConfig(DEFAULT_OFFLINE_CONFIG, readConfig(projectPath, notify));
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

function isLocalProvider(provider: string | undefined, config: OfflineConfig): boolean {
	if (!provider) return false;
	const localProviders = new Set(config.localProviders.map(normalize));
	return localProviders.has(normalize(provider));
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

function getRegistryPolicy(registry: ModelRegistryLike): RegistryPolicy | undefined {
	if (!registry || typeof registry !== "object") return undefined;
	let policy = registryPolicies.get(registry);
	if (!policy) {
		policy = { activeConfigs: new Map() };
		registryPolicies.set(registry, policy);
	}
	return policy;
}

function unionLocalProviders(configs: Iterable<OfflineConfig>): Set<string> {
	const providers = new Set<string>();
	for (const config of configs) {
		for (const provider of config.localProviders) providers.add(normalize(provider));
	}
	return providers;
}

export function installModelRegistryFilter(registry: ModelRegistryLike): void {
	if (!registry || typeof registry !== "object" || typeof registry.getAvailable !== "function") return;
	const policy = getRegistryPolicy(registry);
	if (!policy || policy.originalGetAvailable) return;

	policy.originalGetAvailable = registry.getAvailable;
	registry.getAvailable = function getOfflineAvailable(this: ModelRegistryLike): ModelLike[] {
		const available = policy.originalGetAvailable?.call(this) ?? [];
		if (policy.activeConfigs.size === 0) return available;
		const localProviders = unionLocalProviders(policy.activeConfigs.values());
		return available.filter((model) => localProviders.has(normalize(model.provider)));
	};
}

function setRegistryOfflinePolicy(registry: ModelRegistryLike, owner: symbol, active: boolean, config: OfflineConfig): void {
	const policy = getRegistryPolicy(registry);
	if (!policy) return;
	installModelRegistryFilter(registry);
	if (active) policy.activeConfigs.set(owner, config);
	else policy.activeConfigs.delete(owner);
}

function hasInheritedRegistryOfflinePolicy(registry: ModelRegistryLike, owner: symbol): boolean {
	const policy = getRegistryPolicy(registry);
	if (!policy) return false;
	if (policy.activeConfigs.has(owner)) return false;
	return policy.activeConfigs.size > 0;
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
	const owner = Symbol("offline-mode-session");
	let sessionActive = false;
	let effectiveActive = false;
	let notifiedSessionStart = false;
	const notifiedErrors = new Set<string>();

	function notifyOnce(ctx: ExtensionContext, key: string, message: string, type: "info" | "warning" | "error" = "info"): void {
		if (notifiedErrors.has(key)) return;
		notifiedErrors.add(key);
		ctx.ui.notify(message, type);
	}

	function restoreSessionState(ctx: ExtensionContext): void {
		notifiedSessionStart = false;
		sessionActive = readSessionOfflineState(ctx) ?? false;
	}

	function refreshState(ctx: ExtensionContext): void {
		config = loadOfflineConfig(ctx.cwd, (message, type) => notifyOnce(ctx, `config:${message}`, message, type));
		setRegistryOfflinePolicy(ctx.modelRegistry, owner, sessionActive, config);
		effectiveActive = sessionActive || hasInheritedRegistryOfflinePolicy(ctx.modelRegistry, owner);
		installModelRegistryFilter(ctx.modelRegistry);
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("offline", effectiveActive ? config.statusText : undefined);
	}

	async function applyOffline(ctx: ExtensionContext, options: { restoreSession?: boolean } = {}): Promise<void> {
		if (options.restoreSession) restoreSessionState(ctx);
		refreshState(ctx);
		updateStatus(ctx);
		if (!effectiveActive) return;
		await forceLocalModel(pi, ctx, config, (message, type) => notifyOnce(ctx, `model:${message}`, message, type));
	}

	pi.registerCommand("offline", {
		description: "Control offline mode (on/off/status)",
		getArgumentCompletions: (prefix: string) => {
			const query = prefix.trim().toLowerCase();
			return ["on", "off", "status"].filter((item) => item.startsWith(query)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on") {
				sessionActive = true;
				writeSessionOfflineState(pi, true);
				await applyOffline(ctx);
				ctx.ui.notify(`Offline mode ${offlineStatus(config, effectiveActive)}`, "info");
				return;
			}
			if (action === "off") {
				sessionActive = false;
				writeSessionOfflineState(pi, false);
				await applyOffline(ctx);
				ctx.ui.notify("Offline mode off", "info");
				return;
			}
			if (action === "status") {
				refreshState(ctx);
				updateStatus(ctx);
				ctx.ui.notify(`Offline mode ${offlineStatus(config, effectiveActive)}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /offline on|off|status", "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await applyOffline(ctx, { restoreSession: true });
		if (effectiveActive && config.notifyOnSessionStart && !notifiedSessionStart) {
			ctx.ui.notify(NOTIFICATION_TEXT, "info");
			notifiedSessionStart = true;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await applyOffline(ctx);
		if (!effectiveActive) return;
		return { systemPrompt: appendOfflinePrompt(event.systemPrompt) };
	});

	pi.on("tool_call", async (event, ctx) => {
		await applyOffline(ctx);
		if (!effectiveActive) return;

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
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setRegistryOfflinePolicy(ctx.modelRegistry, owner, false, config);
	});
}
