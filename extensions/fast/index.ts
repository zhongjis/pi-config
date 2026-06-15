import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "fast";

type PayloadRecord = Record<string, unknown>;

type HeaderModel = {
	headers?: Record<string, string>;
};

/**
 * A provider-specific recipe for enabling Fast mode. Eligibility is mutually
 * exclusive across profiles because a model belongs to exactly one provider,
 * so a single `/fast` toggle can drive whichever profile matches the active
 * model.
 */
type FastProfile = {
	/** Stable identifier used only in messages. */
	id: string;
	provider: string;
	api: string;
	models: Set<string>;
	/** When true, the profile only applies under provider OAuth auth. */
	requireOAuth: boolean;
	/** Payload field injected into eligible outbound requests. */
	injectionKey: string;
	injectionValue: string;
	/** Human-readable description of the injection for status messages. */
	describeInjection: string;
	/**
	 * Optional model mutation applied whenever status refreshes (model select,
	 * toggle, outbound request). Used by Anthropic to sync the beta header.
	 * Must be idempotent and safe to call when `shouldEnable` is false.
	 */
	syncModel?: (ctx: ExtensionContext, shouldEnable: boolean) => void;
};

const FAST_SERVICE_TIER = "priority";
const FAST_SPEED = "fast";
const FAST_BETA = "fast-mode-2026-02-01";
const CLAUDE_CODE_OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

function splitBetaHeader(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function syncAnthropicBetaHeader(ctx: ExtensionContext, shouldEnable: boolean): void {
	const model = ctx.model as (typeof ctx.model & HeaderModel) | undefined;
	if (!model || model.provider !== "anthropic" || model.api !== "anthropic-messages") return;

	const headers = { ...(model.headers ?? {}) };
	const existing = splitBetaHeader(headers["anthropic-beta"] ?? headers["Anthropic-Beta"]);
	const requiredBase = ctx.modelRegistry.isUsingOAuth(model) ? CLAUDE_CODE_OAUTH_BETAS : [];
	const next = shouldEnable
		? Array.from(new Set([...existing, ...requiredBase, FAST_BETA]))
		: existing.filter((beta) => beta !== FAST_BETA);

	delete headers["Anthropic-Beta"];
	if (next.length > 0) headers["anthropic-beta"] = next.join(",");
	else delete headers["anthropic-beta"];
	model.headers = headers;
}

const PROFILES: FastProfile[] = [
	{
		id: "openai",
		provider: "openai-codex",
		api: "openai-codex-responses",
		models: new Set(["gpt-5.4", "gpt-5.5"]),
		requireOAuth: true,
		injectionKey: "service_tier",
		injectionValue: FAST_SERVICE_TIER,
		describeInjection: `service_tier=${FAST_SERVICE_TIER}`,
	},
	{
		id: "claude",
		provider: "anthropic",
		api: "anthropic-messages",
		models: new Set(["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"]),
		requireOAuth: false,
		injectionKey: "speed",
		injectionValue: FAST_SPEED,
		describeInjection: `speed=${FAST_SPEED}`,
		syncModel: syncAnthropicBetaHeader,
	},
];

type SessionState = {
	/** Session-only Fast toggle. Defaults off; persists for the session. */
	enabled: boolean;
	lastInjectedAt?: number;
	lastInjectedModel?: string;
};

type Eligibility = {
	eligible: boolean;
	modelKey: string;
	reason?: string;
};

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function modelKey(ctx: ExtensionContext): string {
	const model = ctx.model;
	return model ? `${model.provider}/${model.id}` : "no-model";
}

/** Resolve the Fast profile for the active model's provider, if any. */
function resolveProfile(ctx: ExtensionContext): FastProfile | undefined {
	const provider = ctx.model?.provider;
	if (!provider) return undefined;
	return PROFILES.find((profile) => profile.provider === provider);
}

function getEligibility(ctx: ExtensionContext, profile: FastProfile | undefined): Eligibility {
	const model = ctx.model;
	if (!model) {
		return { eligible: false, modelKey: "no-model", reason: "no model is selected" };
	}

	const key = `${model.provider}/${model.id}`;
	if (!profile) {
		return {
			eligible: false,
			modelKey: key,
			reason: `no Fast profile for provider ${model.provider}`,
		};
	}

	if (model.api !== profile.api) {
		return {
			eligible: false,
			modelKey: key,
			reason: `current API is ${model.api}, not ${profile.api}`,
		};
	}

	if (!profile.models.has(model.id)) {
		return {
			eligible: false,
			modelKey: key,
			reason: `Fast mode is not enabled for ${model.id}`,
		};
	}

	if (profile.requireOAuth && !ctx.modelRegistry.isUsingOAuth(model)) {
		return {
			eligible: false,
			modelKey: key,
			reason: "OAuth/subscription auth is required; API-key auth is intentionally not used",
		};
	}

	return { eligible: true, modelKey: key };
}

function describeMode(state: SessionState): string {
	return state.enabled ? "on" : "off";
}

function updateStatus(ctx: ExtensionContext, state: SessionState): void {
	const profile = resolveProfile(ctx);
	const eligible = !!profile && getEligibility(ctx, profile).eligible;
	const active = state.enabled && eligible;

	// Model mutation (Anthropic beta header) must run regardless of UI, since it
	// affects outbound requests. Each model object carries its own headers, so a
	// model switch refreshes the correct one.
	profile?.syncModel?.(ctx, active);

	if (!ctx.hasUI) return;
	ctx.ui.setStatus(EXTENSION_ID, active ? "fast" : undefined);
}

function getStatusMessage(ctx: ExtensionContext, state: SessionState): string {
	const profile = resolveProfile(ctx);
	const eligibility = getEligibility(ctx, profile);
	const active = state.enabled && eligibility.eligible;
	const injected = state.lastInjectedAt
		? ` Last injected for ${state.lastInjectedModel ?? "unknown model"} ${Math.max(0, Math.round((Date.now() - state.lastInjectedAt) / 1000))}s ago.`
		: "";

	if (active && profile) {
		return `Fast mode is ${describeMode(state)} and active for ${eligibility.modelKey}; requests will use ${profile.describeInjection}.${injected}`;
	}

	if (state.enabled) {
		return `Fast mode is ${describeMode(state)}, but inactive for ${eligibility.modelKey}: ${eligibility.reason}.${injected}`;
	}

	return `Fast mode is ${describeMode(state)}. Current model: ${eligibility.modelKey}.${injected}`;
}

function injectFast(
	payload: unknown,
	ctx: ExtensionContext,
	state: SessionState,
): PayloadRecord | undefined {
	if (!state.enabled) return undefined;
	const profile = resolveProfile(ctx);
	if (!profile) return undefined;
	if (!getEligibility(ctx, profile).eligible) return undefined;
	if (!isPayloadRecord(payload)) return undefined;
	if (payload.model !== ctx.model?.id) return undefined;
	if (profile.injectionKey in payload) return undefined;

	state.lastInjectedAt = Date.now();
	state.lastInjectedModel = modelKey(ctx);
	return {
		...payload,
		[profile.injectionKey]: profile.injectionValue,
	};
}

export default function fastExtension(pi: ExtensionAPI) {
	const states = new WeakMap<object, SessionState>();

	function getState(ctx: ExtensionContext): SessionState {
		let state = states.get(ctx.sessionManager);
		if (!state) {
			state = { enabled: false };
			states.set(ctx.sessionManager, state);
		}
		return state;
	}

	pi.on("session_start", (_event, ctx) => {
		const state: SessionState = { enabled: false };
		states.set(ctx.sessionManager, state);
		updateStatus(ctx, state);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx, getState(ctx));
	});

	pi.on("before_provider_request", (event, ctx) => {
		const state = getState(ctx);
		const nextPayload = injectFast(event.payload, ctx, state);
		updateStatus(ctx, state);
		return nextPayload;
	});

	pi.registerCommand("fast", {
		description: "Toggle Fast mode for the active model (OpenAI Codex GPT-5.4/5.5 or Claude Opus 4.6/4.7/4.8)",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			const state = getState(ctx);
			const action = args.trim();

			if (!action) {
				state.enabled = !state.enabled;
				updateStatus(ctx, state);
				ctx.ui.notify(getStatusMessage(ctx, state), "info");
				return;
			}

			ctx.ui.notify("Usage: /fast", "warning");
		},
	});
}
