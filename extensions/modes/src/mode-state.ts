import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertFastSupported, readFastPolicy, type FastPolicyEntry } from "../../lib/fast.js";
import { computeActiveToolNames, DEFAULT_BUILTIN_TOOL_NAMES } from "../../lib/active-tools.js";
import { MODES, MODE_COLORS, MODE_META, RESET, SKILL_GATED_MODES } from "./constants.js";
import { loadAgentConfig } from "./config-loader.js";
import { getModePromptSource } from "../../lib/model-family.js";
import { parseModelChain, resolveFirstAvailable, resolveModel } from "../../lib/model-selection.js";
import type { AwaitingUserActionState, Mode, ModeConfig, ModeState, PlanTitleSource, VersionedDelegationPolicy } from "./types.js";

function colored(mode: Mode, text: string): string {
	return `${MODE_COLORS[mode]}${text}${RESET}`;
}

function hasToolPolicy(config: ModeConfig): boolean {
  return Boolean(
    config.builtinToolNames
    || config.extensionToolNames !== undefined
    || config.extensions !== undefined
  );
}

const FU_XI_ONLY_TOOL_NAMES = ["plan_approve", "plan_scaffold"] as const;

function applyFuXiOnlyToolAccess(mode: Mode, toolNames: readonly string[], allToolNames: readonly string[]): string[] {
  const withoutFuXiOnlyTools = toolNames.filter(
    (toolName) => !FU_XI_ONLY_TOOL_NAMES.includes(toolName as (typeof FU_XI_ONLY_TOOL_NAMES)[number]),
  );
  if (mode !== "fuxi") return withoutFuXiOnlyTools;
  return [
    ...withoutFuXiOnlyTools,
    ...FU_XI_ONLY_TOOL_NAMES.filter((toolName) => allToolNames.includes(toolName)),
  ];
}

function sameToolSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const t of b) if (!set.has(t)) return false;
  return true;
}

function normalizeDelegationTargets(targets: readonly string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const target of targets ?? []) {
    const value = target.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

function delegationPolicyFromConfig(config: ModeConfig): VersionedDelegationPolicy {
  return {
    version: 1,
    allowDelegationTo: normalizeDelegationTargets(config.allowDelegationTo),
    disallowDelegationTo: normalizeDelegationTargets(config.disallowDelegationTo),
  };
}

export function resolveModelFromStr(
	input: string,
	registry: Parameters<typeof resolveModel>[1],
): any | undefined {
	const result = resolveModel(input, registry);
	return typeof result === "string" ? undefined : result;
}

export class ModeStateManager {
	private pi: ExtensionAPI;

	currentMode: Mode = "kuafu";
	cachedConfigs: Record<string, ModeConfig> = {};
	planTitle: string | undefined;
	planTitleSource: PlanTitleSource | undefined;
	planContent: string | undefined;
	pendingPlanReviewId: string | undefined;
	planReviewPending = false;
	awaitingUserAction: AwaitingUserActionState | undefined;
	planReviewApproved = false;
	planReviewFeedback: string | undefined;
	activeCtx: ExtensionContext | undefined;
	plannotatorAvailable: boolean | undefined;
	plannotatorUnavailableReason: string | undefined;
	lastStatusMode: Mode | undefined;

	modelOverride?: string;
	resolvedFamily: "gpt" | "gemini" | "default" = "default";
	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	persistState(): void {
		this.pi.appendEntry<ModeState>("agent-mode", {
			mode: this.currentMode,
			planTitle: this.planTitle,
			planTitleSource: this.planTitleSource,
			planContent: this.planContent,
			planReviewId: this.pendingPlanReviewId,
			planReviewPending: this.planReviewPending,
			awaitingUserAction: this.awaitingUserAction,
			planReviewApproved: this.planReviewApproved,
			planReviewFeedback: this.planReviewFeedback,
			modelOverride: this.modelOverride,
			delegationPolicy: delegationPolicyFromConfig(this.loadConfig(this.currentMode)),
		});
	}

	loadConfig(mode: Mode, family?: "gpt" | "gemini" | "default"): ModeConfig {
		const cacheKey = `${mode}:${family ?? "default"}`;
		if (!this.cachedConfigs[cacheKey]) {
			this.cachedConfigs[cacheKey] = loadAgentConfig(mode, family) ?? { body: "" };
		}
		return this.cachedConfigs[cacheKey]!;
	}

	async applyMode(ctx: ExtensionContext, resetFast = false): Promise<void> {
		const config = this.loadConfig(this.currentMode);
		await this.applyModelFromConfig(config, ctx, resetFast);
		const allToolNames = this.pi.getAllTools().map((t) => t.name);
		const activeToolNames = this.pi.getActiveTools().filter((t) => allToolNames.includes(t));

		let nextActiveToolNames = activeToolNames;
		if (hasToolPolicy(config)) {
			nextActiveToolNames = computeActiveToolNames({
				availableToolNames: allToolNames,
				builtinToolNames: config.builtinToolNames ?? [...DEFAULT_BUILTIN_TOOL_NAMES],
				builtinToolUniverse: DEFAULT_BUILTIN_TOOL_NAMES,
				extensions: config.extensions ?? true,
				extensionTools: config.extensionToolNames,
				allowNesting: config.allowNesting,
			});
		}

		nextActiveToolNames = applyFuXiOnlyToolAccess(this.currentMode, nextActiveToolNames, allToolNames);
		if (!sameToolSet(nextActiveToolNames, activeToolNames)) {
			this.pi.setActiveTools(nextActiveToolNames);
		}

		this.updateStatus(ctx);
	}

	/**
	 * Apply model + thinking level from mode config. Shared by applyMode() and
	 * the before_agent_start hook.
	 *
	 * Guards 2 and 3: skip setModel / setThinkingLevel when unchanged.
	 * Rationale: setModel() writes to session jsonl, settings file, and awaits
	 * model_select extension handlers — each of which may call setStatus() and
	 * force a TUI repaint. The await also splits subsequent UI updates across
	 * ticks, breaking render coalescing. Skipping no-op calls preserves the same
	 * observable outcome while eliminating flicker on same-mode re-apply (e.g.
	 * before_agent_start firing on every user message).
	 */
	async applyModelFromConfig(config: ModeConfig, ctx: ExtensionContext, resetFast = false): Promise<void> {
		const modelSpec = this.modelOverride ?? config.model;
		const resolved = modelSpec ? resolveFirstAvailable(parseModelChain(modelSpec), ctx.modelRegistry) : undefined;
		const previous = readFastPolicy(ctx.sessionManager?.getBranch?.() ?? []);
		const initializeFast = resetFast || !previous || previous.mode !== this.currentMode;
		if (!resolved) {
			if (initializeFast) this.persistFastDefault(ctx, false);
			return;
		}

		// Guard 2: skip setModel if already the active model.
		const current = ctx.model;
		const sameModel =
			current && current.provider === resolved.model.provider && current.id === resolved.model.id;
		if (resolved.fast && (initializeFast || !sameModel)) assertFastSupported(resolved.model, ctx.modelRegistry.isUsingOAuth(resolved.model));
		if (!sameModel && await this.pi.setModel(resolved.model) === false) throw new Error(`Could not apply mode model: ${modelSpec}`);
		this.resolvedFamily = getModePromptSource(resolved.model);
		if (initializeFast) this.persistFastDefault(ctx, resolved.fast === true);

		// Guard 3: skip setThinkingLevel if already at that level.
		// setModel() internally preserves current level for reasoning-capable models, so
		// on same-model paths the prior level is retained and this guard short-circuits.
		if (resolved.thinkingLevel && resolved.thinkingLevel !== this.pi.getThinkingLevel()) {
			this.pi.setThinkingLevel(resolved.thinkingLevel);
		}
	}

	private persistFastDefault(ctx: ExtensionContext, enabled: boolean): void {
		this.pi.appendEntry<FastPolicyEntry>("fast-policy", { version: 1, mode: this.currentMode, source: "mode", enabled });
		this.pi.events?.emit("fast:policy-changed", { sessionId: ctx.sessionManager?.getSessionId?.() });
	}

	updateStatus(ctx: ExtensionContext): void {
		// Guard 4: skip setStatus when label unchanged — setStatus forces ui.requestRender().
		// Label is stable per mode (MODE_META[mode].label + MODE_COLORS[mode]), so comparing
		// by mode is sufficient. This matters on session_start / before_agent_start paths
		// where applyMode() is called without a mode change.
		if (this.lastStatusMode === this.currentMode) return;
		const meta = MODE_META[this.currentMode];
		ctx.ui.setStatus("agent-mode", colored(this.currentMode, meta.label));
		this.lastStatusMode = this.currentMode;
	}

	async switchMode(mode: Mode, ctx: ExtensionContext): Promise<boolean> {
		const previousMode = this.currentMode;
		const previousConfigs = this.cachedConfigs;
		const previousFamily = this.resolvedFamily;
		this.currentMode = mode;
		this.cachedConfigs = {};
		this.resolvedFamily = "default";
		try {
			await this.applyMode(ctx, mode !== previousMode);
		} catch (error) {
			this.currentMode = previousMode;
			this.cachedConfigs = previousConfigs;
			this.resolvedFamily = previousFamily;
			throw error;
		}
		this.persistState();
		return mode !== previousMode && (SKILL_GATED_MODES.has(previousMode) || SKILL_GATED_MODES.has(mode));
	}

	nextMode(): Mode {
		const idx = MODES.indexOf(this.currentMode);
		return MODES[(idx + 1) % MODES.length];
	}

	hasPendingReview(): boolean {
		return this.planReviewPending;
	}

	setAwaitingUserAction(awaitingUserAction: AwaitingUserActionState | undefined): void {
		this.awaitingUserAction = awaitingUserAction;
	}

	clearAwaitingUserAction(kind?: string): void {
		if (!kind || this.awaitingUserAction?.kind === kind) {
			this.awaitingUserAction = undefined;
		}
	}

	resetPlanReviewState(): void {
		this.pendingPlanReviewId = undefined;
		this.planReviewPending = false;
		this.clearAwaitingUserAction("plannotator-review");
		this.planReviewApproved = false;
		this.planReviewFeedback = undefined;
	}
}
