import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "../lib/model.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileConfig {
	providers: string[];
	defaultModel?: string;
	statusText: string;
	blockedAgents?: string[];
	blockedTools?: string[];
	systemPrompt?: string;
	notifyOnSessionStart?: boolean;
}

export interface ProfilesConfig {
	defaultProfile: string;
	profiles: Record<string, ProfileConfig>;
}

type ModelLike = { id: string; provider: string; name?: string };
type ModelRegistryLike = {
	find?: (provider: string, modelId: string) => unknown;
	getAll?: () => ModelLike[];
	getAvailable?: () => ModelLike[];
};

type Notify = (message: string, type: "info" | "warning" | "error") => void;

export const OFFLINE_SYSTEM_PROMPT = `Offline mode is ON.

Constraints:
- Assume no internet access.
- Use only local files, local tools, and local models.
- Do not delegate to wenchang.
- Do not call web, search, or fetch tools.
- Do not suggest online documentation unless the user asks to leave offline mode.
- If external information is missing, state what local evidence is missing and proceed from repo files, local docs, and cached context.`;

const LOCAL_PROFILE_NOTIFICATION = "Local profile active: local models only; web tools and wenchang disabled.";
export const PROFILE_STATE_CUSTOM_TYPE = "panda:profile";

type ProfileState = { name: string };
type SessionEntryLike = { type?: string; customType?: string; data?: unknown };
type RegistryPolicy = {
	activeConfigs: Map<symbol, ProfileConfig>;
	originalGetAvailable?: ModelRegistryLike["getAvailable"];
};

type SessionContext = ExtensionContext & {
	sessionManager?: { getEntries?: () => unknown[] };
};

type ProfilesExtensionAPI = ExtensionAPI & {
	appendEntry?: (customType: string, data: unknown) => void;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PROFILES_CONFIG: ProfilesConfig = {
	defaultProfile: "default",
	profiles: {
		default: {
			providers: ["anthropic", "openai-codex", "openai", "amazon-bedrock", "google"],
			defaultModel: "anthropic/claude-opus-4-7",
			statusText: "default",
		},
		opencode: {
			providers: ["opencode-go", "opencode"],
			defaultModel: "opencode-go/kimi-k2.6",
			statusText: "opencode",
		},
		local: {
			providers: ["llama-swap"],
			defaultModel: "llama-swap/qwen2.5-coder:14b",
			statusText: "local",
			blockedAgents: ["wenchang"],
			blockedTools: ["web_search", "code_search", "fetch_content", "get_search_content"],
			systemPrompt: OFFLINE_SYSTEM_PROMPT,
			notifyOnSessionStart: true,
		},
	},
};

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isProfileState(value: unknown): value is ProfileState {
	return isRecord(value) && typeof value.name === "string";
}

function readSessionProfile(ctx: ExtensionContext): string | undefined {
	const entries = ((ctx as SessionContext).sessionManager?.getEntries?.() ?? []) as SessionEntryLike[];
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== PROFILE_STATE_CUSTOM_TYPE) continue;
		if (isProfileState(entry.data)) return entry.data.name;
	}
	return undefined;
}

function writeSessionProfile(pi: ExtensionAPI, name: string): void {
	(pi as ProfilesExtensionAPI).appendEntry?.(PROFILE_STATE_CUSTOM_TYPE, { name });
}

// ---------------------------------------------------------------------------
// Registry filtering (shared policy map)
// ---------------------------------------------------------------------------

const registryPolicies = new WeakMap<object, RegistryPolicy>();

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

function isAllowedProvider(provider: string | undefined, config: ProfileConfig): boolean {
	if (!provider) return false;
	const allowed = new Set(config.providers.map(normalize));
	return allowed.has(normalize(provider));
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

function unionAllowedProviders(configs: ProfileConfig[]): Set<string> {
	// When multiple profile filters are active (shouldn't happen — single owner — but safe default),
	// union the allowed sets. In practice activeConfigs.size is always 0 or 1.
	const providers = new Set<string>();
	for (const config of configs) {
		for (const provider of config.providers) providers.add(normalize(provider));
	}
	return providers;
}

export function installModelRegistryFilter(registry: ModelRegistryLike): void {
	if (!registry || typeof registry !== "object" || typeof registry.getAvailable !== "function") return;
	const policy = getRegistryPolicy(registry);
	if (!policy || policy.originalGetAvailable) return;

	policy.originalGetAvailable = registry.getAvailable;
	registry.getAvailable = function getProfileAvailable(this: ModelRegistryLike): ModelLike[] {
		const available = policy.originalGetAvailable?.call(this) ?? [];
		if (policy.activeConfigs.size === 0) return available;
		const allowed = unionAllowedProviders(Array.from(policy.activeConfigs.values()));
		return available.filter((model) => allowed.has(normalize(model.provider)));
	};
}

function setRegistryProfilePolicy(
	registry: ModelRegistryLike,
	owner: symbol,
	active: boolean,
	config: ProfileConfig,
): void {
	const policy = getRegistryPolicy(registry);
	if (!policy) return;
	installModelRegistryFilter(registry);
	if (active) policy.activeConfigs.set(owner, config);
	else policy.activeConfigs.delete(owner);
}

// ---------------------------------------------------------------------------
// Model forcing
// ---------------------------------------------------------------------------

function findConfigModel(modelName: string | undefined, registry: ModelRegistryLike): unknown | undefined {
	if (!modelName) return undefined;
	const resolved = resolveModel(modelName, registry as never);
	return typeof resolved === "string" ? undefined : resolved;
}

function findFirstAllowedModel(registry: ModelRegistryLike, config: ProfileConfig): unknown | undefined {
	const available = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
	return available.find((model) => isAllowedProvider(model.provider, config));
}

async function setModel(pi: ExtensionAPI, model: unknown, notify?: Notify): Promise<boolean> {
	const ok = await pi.setModel(model as never);
	if (ok === false) {
		const typed = model as { provider?: string; id?: string };
		notify?.(`Profiles: model unavailable: ${typed.provider ?? "unknown"}/${typed.id ?? "unknown"}`, "error");
		return false;
	}
	return true;
}

export async function forceProfileModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: ProfileConfig,
	notify?: Notify,
): Promise<void> {
	if (isAllowedProvider(ctx.model?.provider, config)) return;
	const target = findConfigModel(config.defaultModel, ctx.modelRegistry) ?? findFirstAllowedModel(ctx.modelRegistry, config);
	if (!target) {
		notify?.(`Profiles: no model available for providers: ${config.providers.join(", ")}`, "error");
		return;
	}
	await setModel(pi, target, notify);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function profilesExtension(pi: ExtensionAPI): void {
	const config = DEFAULT_PROFILES_CONFIG;
	const owner = Symbol("profiles-session");
	let activeName = DEFAULT_PROFILES_CONFIG.defaultProfile;
	let cliFlagConsumed = false;
	const notifiedErrors = new Set<string>();

	function notifyOnce(
		ctx: ExtensionContext,
		key: string,
		message: string,
		type: "info" | "warning" | "error" = "info",
	): void {
		if (notifiedErrors.has(key)) return;
		notifiedErrors.add(key);
		ctx.ui.notify(message, type);
	}

	function resolveInitialProfile(ctx: ExtensionContext): string {
		// Priority: CLI flag (this run, explicit) > session state > env var > hardcoded default.
		if (!cliFlagConsumed) {
			const flagValue = pi.getFlag("profile");
			if (typeof flagValue === "string" && flagValue.trim()) {
				const name = flagValue.trim();
				cliFlagConsumed = true;
				if (config.profiles[name]) return name;
				notifyOnce(ctx, `cli-unknown:${name}`, `Profiles: --profile "${name}" is unknown; falling back.`, "warning");
			}
		}
		const sessionName = readSessionProfile(ctx);
		if (sessionName && config.profiles[sessionName]) return sessionName;
		const envName = process.env.PI_PROFILE?.trim();
		if (envName && config.profiles[envName]) return envName;
		if (config.profiles[config.defaultProfile]) return config.defaultProfile;
		return "default";
	}

	function getActiveConfig(): ProfileConfig {
		return config.profiles[activeName] ?? DEFAULT_PROFILES_CONFIG.profiles[activeName] ?? {
			providers: [],
			statusText: activeName,
		};
	}

	function updateStatus(ctx: ExtensionContext): void {
		const active = getActiveConfig();
		// Show indicator for anything other than plain "default" — users want to know when non-default is active.
		const show = activeName !== DEFAULT_PROFILES_CONFIG.defaultProfile;
		ctx.ui.setStatus("profile", show ? `profile: ${active.statusText}` : undefined);
	}

	async function applyProfile(ctx: ExtensionContext, options: { restoreSession?: boolean } = {}): Promise<void> {
		if (options.restoreSession) {
			activeName = resolveInitialProfile(ctx);
			// CLI flag is persisted to session state so subsequent turns remember it
			// without re-reading the flag. Matches how `/profile <name>` behaves.
			const flagValue = pi.getFlag("profile");
			if (typeof flagValue === "string" && flagValue.trim() && config.profiles[flagValue.trim()]) {
				writeSessionProfile(pi, flagValue.trim());
			}
		} else if (!config.profiles[activeName]) {
			// Config was edited mid-session and dropped the current profile — fall back.
			activeName = resolveInitialProfile(ctx);
		}

		const active = getActiveConfig();
		setRegistryProfilePolicy(ctx.modelRegistry, owner, true, active);
		updateStatus(ctx);
		await forceProfileModel(pi, ctx, active, (message, type) => notifyOnce(ctx, `model:${message}`, message, type));
	}

	/** Switch to a named profile. Shared by /profile <name>, /profile:<name>, and CLI. */
	async function switchProfile(name: string, ctx: ExtensionContext): Promise<void> {
		if (!config.profiles[name]) {
			ctx.ui.notify(
				`Unknown profile "${name}". Available: ${Object.keys(config.profiles).join(", ")}`,
				"error",
			);
			return;
		}
		activeName = name;
		writeSessionProfile(pi, name);
		// Clear notified errors so a new profile can re-surface model-unavailable errors if any.
		notifiedErrors.clear();
		await applyProfile(ctx);
		ctx.ui.notify(`Profile: ${name}`, "info");
	}

	// CLI flag: `pi --profile opencode`
	pi.registerFlag("profile", {
		description: "Set the provider profile for this session (default/opencode/local/...).",
		type: "string",
	});

	// Primary slash command: /profile [status|<name>]
	pi.registerCommand("profile", {
		description: "Control provider profile (default/opencode/local/status)",
		getArgumentCompletions: (prefix: string) => {
			const query = prefix.trim().toLowerCase();
			const options = ["status", ...Object.keys(config.profiles)];
			return options
				.filter((item) => item.startsWith(query))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";

			if (action === "status") {
				const active = getActiveConfig();
				ctx.ui.notify(
					`Profile: ${activeName} (providers: ${active.providers.join(", ") || "<none>"})`,
					"info",
				);
				return;
			}

			await switchProfile(action, ctx);
		},
	});

	// Shortcut slash commands: /profile:<name> for each built-in profile.
	for (const shortcutName of Object.keys(DEFAULT_PROFILES_CONFIG.profiles)) {
		pi.registerCommand(`profile:${shortcutName}`, {
			description: `Switch to the "${shortcutName}" provider profile`,
			handler: async (_args, ctx) => {
				await switchProfile(shortcutName, ctx);
			},
		});
	}

	let notifiedSessionStart = false;

	function appendSystemPrompt(systemPrompt: string, extra: string): string {
		if (systemPrompt.includes(extra)) return systemPrompt;
		return systemPrompt.trimEnd() ? `${systemPrompt.trimEnd()}\n\n${extra}` : extra;
	}

	pi.on("session_start", async (_event, ctx) => {
		notifiedSessionStart = false;
		await applyProfile(ctx, { restoreSession: true });
		const active = getActiveConfig();
		if (active.notifyOnSessionStart && !notifiedSessionStart) {
			ctx.ui.notify(LOCAL_PROFILE_NOTIFICATION, "info");
			notifiedSessionStart = true;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await applyProfile(ctx);
		const active = getActiveConfig();
		if (active.systemPrompt) {
			return { systemPrompt: appendSystemPrompt(event.systemPrompt, active.systemPrompt) };
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		await applyProfile(ctx);
		const active = getActiveConfig();

		if (active.blockedTools?.map(normalize).includes(normalize(event.toolName))) {
			return {
				block: true,
				reason: `Profile "${activeName}": tool "${event.toolName}" is disabled.`,
			};
		}

		if (event.toolName !== "Agent") return;

		const requestedType = typeof event.input.subagent_type === "string" ? event.input.subagent_type : "";
		if (active.blockedAgents?.map(normalize).includes(normalize(requestedType))) {
			return {
				block: true,
				reason: `Profile "${activeName}": delegation to "${requestedType}" is disabled.`,
			};
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setRegistryProfilePolicy(ctx.modelRegistry, owner, false, getActiveConfig());
	});
}
