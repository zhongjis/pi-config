/** Stateless Fast provider recipes. Callers own policy and request lifecycle. */
export interface FastModel {
	readonly provider: string;
	readonly api: string;
	readonly id: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export interface FastPolicy {
	readonly enabled: boolean;
	readonly usingOAuth: boolean;
	/** Already validated fixed policy: override conflicts; never downgrade on auth drift. */
	readonly strict?: boolean;
}

export interface FastProfile {
	readonly id: string;
	readonly provider: string;
	readonly api: string;
	readonly models: readonly string[];
	readonly requireOAuth: boolean;
	readonly injectionKey: string;
	readonly injectionValue: string;
	readonly describeInjection: string;
}

const PROFILES: readonly FastProfile[] = [
	{
		id: "openai", provider: "openai-codex", api: "openai-codex-responses",
		models: ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"], requireOAuth: true,
		injectionKey: "service_tier", injectionValue: "priority", describeInjection: "service_tier=priority",
	},
	{
		id: "claude", provider: "anthropic", api: "anthropic-messages",
		models: ["claude-opus-4-8", "claude-opus-5"], requireOAuth: false,
		injectionKey: "speed", injectionValue: "fast", describeInjection: "speed=fast",
	},
];
const FAST_BETA = "fast-mode-2026-02-01";
const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"] as const;

export interface FastEligibility {
	readonly eligible: boolean;
	readonly modelKey: string;
	readonly reason?: string;
}

export function getFastProfile(model: FastModel | undefined): FastProfile | undefined {
	return PROFILES.find((profile) => profile.provider === model?.provider);
}

export function getFastEligibility(model: FastModel | undefined, usingOAuth: boolean): FastEligibility {
	if (!model) return { eligible: false, modelKey: "no-model", reason: "no model is selected" };
	const modelKey = `${model.provider}/${model.id}`;
	const profile = getFastProfile(model);
	let reason: string | undefined;
	if (!profile) reason = `no Fast profile for provider ${model.provider}`;
	else if (model.api !== profile.api) reason = `current API is ${model.api}, not ${profile.api}`;
	else if (!profile.models.includes(model.id)) reason = `Fast mode is not enabled for ${model.id}`;
	else if (profile.requireOAuth && !usingOAuth) reason = "OAuth/subscription auth is required; API-key auth is intentionally not used";
	return reason ? { eligible: false, modelKey, reason } : { eligible: true, modelKey };
}

/** Returns a replacement payload, or undefined when no change is needed. */
export function transformFastPayload(payload: unknown, model: FastModel | undefined, policy: FastPolicy): Record<string, unknown> | undefined {
	const profile = getFastProfile(model);
	if (!profile || model?.api !== profile.api) return undefined;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	if (!("model" in payload) || payload.model !== model.id) return undefined;
	const next: Record<string, unknown> = { ...payload };
	if (!policy.enabled) {
		if (!policy.strict || next[profile.injectionKey] !== profile.injectionValue) return undefined;
		delete next[profile.injectionKey];
		return next;
	}
	if (policy.strict ? !profile.models.includes(model.id) : !getFastEligibility(model, policy.usingOAuth).eligible) return undefined;
	if (!policy.strict && profile.injectionKey in payload) return undefined;
	return { ...next, [profile.injectionKey]: profile.injectionValue };
}

/** Merge request/model headers without mutation; mask every observed beta casing. */
export function transformFastHeaders(headers: Readonly<Record<string, string | null>> | undefined, model: FastModel | undefined, policy: FastPolicy): Record<string, string | null> {
	const next = { ...model?.headers, ...headers };
	if (model?.provider !== "anthropic" || model.api !== "anthropic-messages") return next;
	const existing: string[] = [];
	const betaKeys = new Set<string>();
	for (const [key, value] of [...Object.entries(model.headers ?? {}), ...Object.entries(headers ?? {})]) {
		if (key.toLowerCase() !== "anthropic-beta") continue;
		betaKeys.add(key);
		existing.push(...(value ?? "").split(",").map((part) => part.trim()).filter(Boolean));
	}
	const active = policy.enabled && (policy.strict
		? !!getFastProfile(model)?.models.includes(model.id)
		: getFastEligibility(model, policy.usingOAuth).eligible);
	const betas = active
		? [...new Set([...existing, ...(policy.usingOAuth ? OAUTH_BETAS : []), FAST_BETA])]
		: [...new Set(existing.filter((beta) => beta !== FAST_BETA))];
	if (betas.length || betaKeys.size) {
		betaKeys.add("anthropic-beta");
		for (const key of betaKeys) next[key] = betas.join(",");
	}
	return next;
}

export interface FastPolicyEntry {
	version: 1;
	mode: string;
	source: "mode" | "user";
	enabled: boolean;
}

/** Read only the current branch; extensions retain lifecycle ownership. */
export function readFastPolicy(entries: readonly unknown[]): FastPolicyEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (typeof entry !== "object" || entry === null || !("customType" in entry) || entry.customType !== "fast-policy" || !("data" in entry)) continue;
		const data = entry.data;
		if (typeof data === "object" && data !== null && "version" in data && data.version === 1 && "mode" in data && typeof data.mode === "string" && "source" in data && (data.source === "mode" || data.source === "user") && "enabled" in data && typeof data.enabled === "boolean") {
			return { version: 1, mode: data.mode, source: data.source, enabled: data.enabled };
		}
	}
	return undefined;
}

/** Validate the selected candidate, never use Fast capability to choose a fallback. */
export function assertFastSupported(model: FastModel | undefined, usingOAuth: boolean): void {
	const result = getFastEligibility(model, usingOAuth);
	if (!result.eligible) throw new Error(`Explicit :fast is unsupported for ${result.modelKey}: ${result.reason}`);
}
