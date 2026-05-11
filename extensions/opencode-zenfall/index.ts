/**
 * OpenCode Go → Zen failover.
 *
 * Intercepts `opencode-go` streaming requests. On 429/402 errors, transparently
 * retries via the `opencode` (Zen) provider using the same OPENCODE_API_KEY.
 *
 * Design parity with extensions/clauderock:
 * - Per-model cache (Go quotas are per-model-per-month; global flag would
 *   over-route).
 * - 6-hour TTL per entry (safety net against being stuck on Zen after Go
 *   resets).
 * - Zen-equivalent mapping validated at session_start (only 8 of 12 Go models
 *   have Zen equivalents; the other 4 forward errors without rotation).
 * - Status bar shows `● OpenCode-Zen` when fallback active for current model.
 * - Slash command `/opencode-zenfall status|on|off|health`.
 */

import {
	type Context,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
	createKeyedFallbackCache,
	createOnceNotifier,
	isQuotaOrRateLimitError,
	patchEventModelId,
	streamWithFallback,
} from "../lib/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CACHE_FILE = "opencode-zenfall-state.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — auto-retry Go after reset
const GO_PROVIDER = "opencode-go";
const ZEN_PROVIDER = "opencode";

// Models present in both opencode-go and opencode providers (verified against
// pi-ai v0.73.1 models.generated.js). Models not in this set will not rotate
// on failure — the error forwards through to the user.
const GO_MODELS_WITH_ZEN_EQUIVALENT: ReadonlySet<string> = new Set([
	"glm-5",
	"glm-5.1",
	"kimi-k2.5",
	"kimi-k2.6",
	"minimax-m2.5",
	"minimax-m2.7",
	"qwen3.5-plus",
	"qwen3.6-plus",
]);

const GO_MODELS_WITHOUT_ZEN: readonly string[] = [
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"mimo-v2.5",
	"mimo-v2.5-pro",
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const cache = createKeyedFallbackCache(CACHE_FILE, { ttlMs: CACHE_TTL_MS });
const notifier = createOnceNotifier();

let isGoProvider = false;
let currentModelId: string | undefined;
let agentStarted = false;
let sessionNotified = false;
let gapNotifiedThisSession = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasZenEquivalent(modelId: string): boolean {
	return GO_MODELS_WITH_ZEN_EQUIVALENT.has(modelId);
}

function buildZenModel(goModel: Model<any>): Model<any> {
	// opencode-go and opencode share the same id strings and the same
	// openai-completions API. The only thing changing is the provider label
	// (which drives pi-ai's baseUrl + API key routing).
	return {
		...goModel,
		provider: ZEN_PROVIDER,
	};
}

function isActiveFor(modelId: string | undefined): boolean {
	if (!modelId) return false;
	return cache.read(modelId) !== undefined;
}

function updateStatusBar(ctx: {
	ui: { setStatus(k: string, v: string | undefined): void; theme: { fg(c: string, t: string): string } };
}): void {
	if (!isGoProvider || !isActiveFor(currentModelId)) {
		ctx.ui.setStatus("opencode-zenfall", undefined);
		return;
	}
	ctx.ui.setStatus(
		"opencode-zenfall",
		ctx.ui.theme.fg("warning", "● OpenCode-Zen"),
	);
}

function notifyGapOnce(ctx: {
	ui: { notify(msg: string, t: "info" | "warning" | "error"): void; theme: { fg(c: string, t: string): string } };
}): void {
	if (gapNotifiedThisSession) return;
	if (!GO_MODELS_WITHOUT_ZEN.some((id) => currentModelId === id)) return;
	gapNotifiedThisSession = true;
	ctx.ui.notify(
		`${ctx.ui.theme.fg("warning", "!")} ${currentModelId} has no Zen fallback — quota errors will surface directly`,
		"warning",
	);
}

// ---------------------------------------------------------------------------
// Stream wrapper — called by pi-ai for every opencode-go request
// ---------------------------------------------------------------------------

function streamSimpleWithFallback(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) {
	const modelId = model.id;

	// No Zen equivalent — forward directly to opencode-go primary, no rotation.
	if (!hasZenEquivalent(modelId)) {
		return streamSimple(model, context, options);
	}

	return streamWithFallback({
		model,
		context,
		options,

		tryPrimary: (m, c, o) => streamSimple(m, c, o),

		tryFallback: (m, c, o) => {
			const zenModel = buildZenModel(m);
			return streamSimple(zenModel, c, o);
		},

		isFailure: isQuotaOrRateLimitError,

		shouldSkipPrimary: () => isActiveFor(modelId),

		onFallbackActivated: (reason) => {
			cache.write(modelId, reason);
			notifier.queue(
				`⚠ OpenCode Go quota hit for ${modelId} — switching to Zen`,
				"warning",
			);
		},

		onCachedFallback: () => {
			if (!sessionNotified) {
				notifier.queue(
					`Using OpenCode Zen for ${modelId} — Go quota exhausted. Run /opencode-zenfall off ${modelId} to retry Go.`,
					"info",
				);
			}
		},

		// Zen emits events tagged with provider "opencode" / id preserved.
		// Patch back to the Go model identity so pi state stays clean.
		patchFallbackEvent: (event) => patchEventModelId(event, modelId),
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function openCodeZenfall(pi: ExtensionAPI): void {
	// Session lifecycle
	pi.on("session_start", async (_event, ctx) => {
		sessionNotified = false;
		agentStarted = false;
		gapNotifiedThisSession = false;
		isGoProvider = (ctx as any).model?.provider === GO_PROVIDER;
		currentModelId = (ctx as any).model?.id;
		updateStatusBar(ctx as any);
	});

	pi.on("model_select", async (event, ctx) => {
		const m = (event as any).model;
		isGoProvider = m?.provider === GO_PROVIDER;
		currentModelId = m?.id;
		updateStatusBar(ctx as any);
	});

	pi.on("agent_start", async (_event, _ctx) => {
		agentStarted = true;
	});

	// First user message of a live turn — notify if fallback is cached.
	pi.on("message_start", async (event, ctx) => {
		if ((event as any).message?.role !== "user") return;
		if (!agentStarted) return;
		if (!isGoProvider) return;

		notifyGapOnce(ctx as any);

		if (isActiveFor(currentModelId) && !sessionNotified) {
			(ctx as any).ui.notify(
				`Using OpenCode Zen for ${currentModelId} — Go quota was previously exhausted. Run ${(ctx as any).ui.theme.fg(
					"accent",
					`/opencode-zenfall off ${currentModelId}`,
				)} to retry Go.`,
				"info",
			);
			updateStatusBar(ctx as any);
			sessionNotified = true;
		}
	});

	// Turn end — flush any queued notification (quota_exhausted from mid-stream)
	pi.on("turn_end", async (_event, ctx) => {
		if (notifier.hasPending()) {
			notifier.drain(ctx as any);
			updateStatusBar(ctx as any);
			sessionNotified = true;
		}
	});

	// Slash command
	pi.registerCommand("opencode-zenfall", {
		description: "OpenCode Go ↔ Zen routing (status | on <id> | off [<id>] | health)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [
				{ value: "status", label: "status  — show active fallback entries" },
				{ value: "on", label: "on <model-id>  — force Zen for a specific model" },
				{ value: "off", label: "off [<model-id>]  — clear one entry, or all if omitted" },
				{ value: "health", label: "health  — list models with/without Zen equivalents" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const action = (parts[0] || "status").toLowerCase();
			const target = parts[1];
			const t = (ctx as any).ui.theme;

			if (action === "off") {
				if (target) {
					cache.clearKey(target);
					updateStatusBar(ctx as any);
					(ctx as any).ui.notify(
						`${t.fg("success", "✓")} Cleared Zenfall entry for ${target}`,
						"info",
					);
				} else {
					cache.clear();
					sessionNotified = false;
					updateStatusBar(ctx as any);
					(ctx as any).ui.notify(
						`${t.fg("success", "✓")} Cleared all Zenfall entries — Go will be retried`,
						"info",
					);
				}
				return;
			}

			if (action === "on") {
				if (!target) {
					(ctx as any).ui.notify(
						`${t.fg("error", "✗")} Usage: /opencode-zenfall on <model-id>`,
						"error",
					);
					return;
				}
				if (!hasZenEquivalent(target)) {
					(ctx as any).ui.notify(
						`${t.fg("error", "✗")} ${target} has no Zen equivalent — cannot force`,
						"error",
					);
					return;
				}
				cache.write(target, "manually forced via /opencode-zenfall on");
				updateStatusBar(ctx as any);
				(ctx as any).ui.notify(
					`${t.fg("warning", "●")} Forced Zen for ${target}`,
					"info",
				);
				return;
			}

			if (action === "health") {
				const lines: string[] = [];
				lines.push(`${t.fg("accent", "Go models with Zen fallback")} (${GO_MODELS_WITH_ZEN_EQUIVALENT.size}):`);
				for (const id of Array.from(GO_MODELS_WITH_ZEN_EQUIVALENT).sort()) {
					const active = cache.read(id);
					const marker = active ? t.fg("warning", "●") : t.fg("dim", "○");
					lines.push(`  ${marker} ${id}${active ? ` (active since ${active.since})` : ""}`);
				}
				lines.push(
					`${t.fg("warning", "!")} ${t.fg("accent", "Go models WITHOUT Zen fallback")} (${GO_MODELS_WITHOUT_ZEN.length}) — errors forward directly:`,
				);
				for (const id of GO_MODELS_WITHOUT_ZEN) {
					lines.push(`  ${t.fg("dim", "✗")} ${id}`);
				}
				(ctx as any).ui.notify(lines.join("\n"), "info");
				return;
			}

			// status (default)
			const all = cache.readAll();
			const activeIds = Object.keys(all);
			if (activeIds.length === 0) {
				(ctx as any).ui.notify(
					`${t.fg("success", "●")} OpenCode Go active for all models. Zenfall on standby.`,
					"info",
				);
				return;
			}
			const lines = [
				`${t.fg("warning", "●")} OpenCode Zenfall — ${activeIds.length} model(s) routed to Zen:`,
			];
			for (const [id, entry] of Object.entries(all)) {
				lines.push(`  ${t.fg("warning", "●")} ${id} — since ${entry.since} (${entry.reason})`);
			}
			(ctx as any).ui.notify(lines.join("\n"), "info");
		},
	});

	// Register the provider wrapper. pi-ai already ships opencode-go as a
	// built-in provider; this overrides its streamSimple to route through
	// our failover wrapper.
	pi.registerProvider(GO_PROVIDER, {
		api: "openai-completions",
		streamSimple: streamSimpleWithFallback,
	});
}
