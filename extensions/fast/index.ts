import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getFastEligibility, getFastProfile, readFastPolicy, transformFastHeaders, transformFastPayload, type FastPolicyEntry } from "../lib/fast.js";

const EXTENSION_ID = "fast";

type SessionState = {
	lastInjectedAt?: number;
	lastInjectedModel?: string;
};

export default function fastExtension(pi: ExtensionAPI) {
	const states = new WeakMap<object, SessionState>();
	let activeCtx: ExtensionContext | undefined;

	function policy(ctx: ExtensionContext) {
		const entry = readFastPolicy(ctx.sessionManager.getBranch());
		return {
			enabled: entry?.enabled ?? false,
			usingOAuth: !!ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model),
			strict: entry?.source === "mode" || (!!entry?.mode && !entry.enabled),
		};
	}

	function getState(ctx: ExtensionContext): SessionState {
		let state = states.get(ctx.sessionManager);
		if (!state) {
			state = {};
			states.set(ctx.sessionManager, state);
		}
		return state;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const current = policy(ctx);
		const model = ctx.model;
		const profile = getFastProfile(model);
		const active = current.enabled && (current.strict
			? !!profile && model?.api === profile.api && profile.models.includes(model.id)
			: getFastEligibility(model, current.usingOAuth).eligible);
		if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, active ? "fast" : undefined);
	}

	function getStatusMessage(ctx: ExtensionContext, state: SessionState): string {
		const profile = getFastProfile(ctx.model);
		const current = policy(ctx);
		const eligibility = getFastEligibility(ctx.model, current.usingOAuth);
		const injected = state.lastInjectedAt
			? ` Last injected for ${state.lastInjectedModel ?? "unknown model"} ${Math.max(0, Math.round((Date.now() - state.lastInjectedAt) / 1000))}s ago.`
			: "";
		if (current.enabled && eligibility.eligible && profile) return `Fast mode is on and active for ${eligibility.modelKey}; requests will use ${profile.describeInjection}.${injected}`;
		if (current.enabled) return `Fast mode is on, but inactive for ${eligibility.modelKey}: ${eligibility.reason}.${injected}`;
		return `Fast mode is off. Current model: ${eligibility.modelKey}.${injected}`;
	}

	const unsubscribe = pi.events.on("fast:policy-changed", (event: unknown) => {
		if (activeCtx && typeof event === "object" && event !== null && "sessionId" in event && event.sessionId === activeCtx.sessionManager.getSessionId()) updateStatus(activeCtx);
	});
	pi.on("session_shutdown", () => { activeCtx = undefined; unsubscribe(); });
	pi.on("session_start", (_event, ctx) => { activeCtx = ctx; updateStatus(ctx); });
	pi.on("model_select", (_event, ctx) => { activeCtx = ctx; updateStatus(ctx); });
	pi.on("before_provider_headers", (event, ctx) => {
		Object.assign(event.headers, transformFastHeaders(event.headers, ctx.model, policy(ctx)));
	});
	pi.on("before_provider_request", (event, ctx) => {
		const current = policy(ctx);
		const next = transformFastPayload(event.payload, ctx.model, current);
		if (next && current.enabled) {
			const state = getState(ctx);
			state.lastInjectedAt = Date.now();
			state.lastInjectedModel = getFastEligibility(ctx.model, current.usingOAuth).modelKey;
		}
		updateStatus(ctx);
		return next;
	});
	pi.registerCommand("fast", {
		description: "Toggle Fast mode for the active model (OAuth Codex GPT-5.4/5.5/5.6-sol/5.6-terra/5.6-luna/6-astra or Claude Opus 4.8/5)",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			if (args.trim()) { ctx.ui.notify("Usage: /fast", "warning"); return; }
			const entry = readFastPolicy(ctx.sessionManager.getBranch());
			pi.appendEntry<FastPolicyEntry>("fast-policy", { version: 1, mode: entry?.mode ?? "", source: "user", enabled: !entry?.enabled });
			updateStatus(ctx);
			ctx.ui.notify(getStatusMessage(ctx, getState(ctx)), "info");
		},
	});
}
