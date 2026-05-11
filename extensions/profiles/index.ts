import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "../lib/model.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileConfig {
	providers: string[];
	defaultModel?: string;
	statusText: string;
}

export interface ProfilesConfig {
	defaultProfile: string;
	profiles: Record<string, ProfileConfig>;
}

type PartialProfileConfig = Partial<ProfileConfig>;
type PartialProfilesConfig = Partial<{
	defaultProfile: string;
	profiles: Record<string, PartialProfileConfig>;
}>;

type ModelLike = { id: string; provider: string; name?: string };
type ModelRegistryLike = {
	find?: (provider: string, modelId: string) => unknown;
	getAll?: () => ModelLike[];
	getAvailable?: () => ModelLike[];
};

type Notify = (message: string, type: "info" | "warning" | "error") => void;

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
		},
	},
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return strings.length === value.length ? strings : undefined;
}

function sanitizeProfile(value: unknown, profileKey: string, path: string, notify?: Notify): PartialProfileConfig {
	if (!isRecord(value)) return {};
	const next: PartialProfileConfig = {};

	const providers = stringArray(value.providers);
	if (providers) next.providers = providers;
	else if ("providers" in value) {
		notify?.(`Profiles: ignoring invalid providers for "${profileKey}" in ${path}`, "warning");
	}

	if (typeof value.defaultModel === "string") next.defaultModel = value.defaultModel;
	else if ("defaultModel" in value) {
		notify?.(`Profiles: ignoring invalid defaultModel for "${profileKey}" in ${path}`, "warning");
	}

	if (typeof value.statusText === "string") next.statusText = value.statusText;
	else if ("statusText" in value) {
		notify?.(`Profiles: ignoring invalid statusText for "${profileKey}" in ${path}`, "warning");
	}

	return next;
}

function sanitizeConfig(value: unknown, path: string, notify?: Notify): PartialProfilesConfig {
	if (!isRecord(value)) return {};
	const next: PartialProfilesConfig = {};

	if (typeof value.defaultProfile === "string") next.defaultProfile = value.defaultProfile;
	else if ("defaultProfile" in value) {
		notify?.(`Profiles: ignoring invalid defaultProfile in ${path}`, "warning");
	}

	if (isRecord(value.profiles)) {
		const profiles: Record<string, PartialProfileConfig> = {};
		for (const [key, raw] of Object.entries(value.profiles)) {
			profiles[key] = sanitizeProfile(raw, key, path, notify);
		}
		next.profiles = profiles;
	} else if ("profiles" in value) {
		notify?.(`Profiles: ignoring invalid profiles in ${path}`, "warning");
	}

	return next;
}

function mergeProfile(base: ProfileConfig | undefined, override: PartialProfileConfig): ProfileConfig {
	const merged: ProfileConfig = {
		providers: override.providers ?? base?.providers ?? [],
		statusText: override.statusText ?? base?.statusText ?? "",
	};
	const defaultModel = override.defaultModel ?? base?.defaultModel;
	if (defaultModel) merged.defaultModel = defaultModel;
	return merged;
}

function mergeConfig(base: ProfilesConfig, override: PartialProfilesConfig): ProfilesConfig {
	const profiles: Record<string, ProfileConfig> = { ...base.profiles };
	if (override.profiles) {
		for (const [key, partial] of Object.entries(override.profiles)) {
			profiles[key] = mergeProfile(profiles[key], partial);
		}
	}
	return {
		defaultProfile: override.defaultProfile ?? base.defaultProfile,
		profiles,
	};
}

function readConfig(path: string, notify?: Notify): PartialProfilesConfig {
	if (!existsSync(path)) return {};
	try {
		return sanitizeConfig(JSON.parse(readFileSync(path, "utf-8")), path, notify);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify?.(`Profiles: failed to read ${path}: ${message}`, "error");
		return {};
	}
}

function getHomeDir(): string | undefined {
	return process.env.HOME ?? process.env.USERPROFILE;
}

export function loadProfilesConfig(cwd: string, notify?: Notify): ProfilesConfig {
	const home = getHomeDir();
	const globalPath = home ? join(home, ".pi", "agent", "profiles.json") : undefined;
	const projectPath = join(cwd, ".pi", "profiles.json");
	const globalConfig = globalPath ? readConfig(globalPath, notify) : {};
	const projectConfig = readConfig(projectPath, notify);
	return mergeConfig(mergeConfig(DEFAULT_PROFILES_CONFIG, globalConfig), projectConfig);
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

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
// Registry filtering (shared policy map — composes with offline extension)
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
	let config = DEFAULT_PROFILES_CONFIG;
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
		// Priority: CLI flag (this run, explicit) > session state > env var > config default > hardcoded.
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
		config = loadProfilesConfig(ctx.cwd, (message, type) => notifyOnce(ctx, `config:${message}`, message, type));

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
		config = loadProfilesConfig(ctx.cwd, (message, type) => notifyOnce(ctx, `config:${message}`, message, type));
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
				config = loadProfilesConfig(ctx.cwd);
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
	// Only the hardcoded defaults get a dedicated command because registerCommand
	// runs at extension-init time, before any config file is loaded. Custom profiles
	// defined in ~/.pi/agent/profiles.json or .pi/profiles.json still work via
	// `/profile <name>` and the --profile CLI flag.
	for (const shortcutName of Object.keys(DEFAULT_PROFILES_CONFIG.profiles)) {
		pi.registerCommand(`profile:${shortcutName}`, {
			description: `Switch to the "${shortcutName}" provider profile`,
			handler: async (_args, ctx) => {
				await switchProfile(shortcutName, ctx);
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		await applyProfile(ctx, { restoreSession: true });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setRegistryProfilePolicy(ctx.modelRegistry, owner, false, getActiveConfig());
	});
}
