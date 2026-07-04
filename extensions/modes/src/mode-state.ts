import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { computeActiveToolNames, DEFAULT_BUILTIN_TOOL_NAMES } from "../../lib/active-tools.js";
import { MODES, MODE_COLORS, MODE_META, RESET, SKILL_GATED_MODES } from "./constants.js";
import { loadAgentConfig } from "./config-loader.js";
import { getModePromptSource } from "../../lib/model-family.js";
import { parseModelChain, resolveFirstAvailable, resolveModel } from "../../lib/model.js";
import type { AwaitingUserActionState, Mode, ModeConfig, ModeState, PlanTitleSource } from "./types.js";

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

const PLAN_APPROVE_TOOL_NAME = "plan_approve";

function applyPlanApproveAccess(mode: Mode, toolNames: readonly string[], allToolNames: readonly string[]): string[] {
  const withoutPlanApprove = toolNames.filter((toolName) => toolName !== PLAN_APPROVE_TOOL_NAME);
  if (mode !== "fuxi" || !allToolNames.includes(PLAN_APPROVE_TOOL_NAME)) return withoutPlanApprove;
  return [...withoutPlanApprove, PLAN_APPROVE_TOOL_NAME];
}

function sameToolSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const t of b) if (!set.has(t)) return false;
  return true;
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
		});
	}

	loadConfig(mode: Mode, family?: "gpt" | "gemini" | "default"): ModeConfig {
		const cacheKey = `${mode}:${family ?? "default"}`;
		if (!this.cachedConfigs[cacheKey]) {
			this.cachedConfigs[cacheKey] = loadAgentConfig(mode, family) ?? { body: "" };
		}
		return this.cachedConfigs[cacheKey]!;
	}

	async applyMode(ctx: ExtensionContext): Promise<void> {
		const config = this.loadConfig(this.currentMode);
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

		nextActiveToolNames = applyPlanApproveAccess(this.currentMode, nextActiveToolNames, allToolNames);
		if (!sameToolSet(nextActiveToolNames, activeToolNames)) {
			this.pi.setActiveTools(nextActiveToolNames);
		}

		await this.applyModelFromConfig(config, ctx);

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
	async applyModelFromConfig(config: ModeConfig, ctx: ExtensionContext): Promise<void> {
		const modelSpec = this.modelOverride ?? config.model;
		if (!modelSpec) return;
		const candidates = parseModelChain(modelSpec);
		const resolved = resolveFirstAvailable(candidates, ctx.modelRegistry);
		if (!resolved) return;
		this.resolvedFamily = getModePromptSource(resolved.model);

		// Guard 2: skip setModel if already the active model.
		const current = ctx.model;
		const sameModel =
			current && current.provider === resolved.model.provider && current.id === resolved.model.id;
		if (!sameModel) {
			await this.pi.setModel(resolved.model);
		}

		// Guard 3: skip setThinkingLevel if already at that level.
		// setModel() internally preserves current level for reasoning-capable models, so
		// on same-model paths the prior level is retained and this guard short-circuits.
		if (resolved.thinkingLevel && resolved.thinkingLevel !== this.pi.getThinkingLevel()) {
			this.pi.setThinkingLevel(resolved.thinkingLevel);
		}
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

	async switchMode(mode: Mode, ctx: ExtensionContext): Promise<void> {
		const previousMode = this.currentMode;
		this.currentMode = mode;
		this.cachedConfigs = {};
		this.resolvedFamily = "default";
		await this.applyMode(ctx);
		this.persistState();
		const reload = (ctx as ExtensionContext & { reload?: () => Promise<void> }).reload;
		if (mode !== previousMode && (SKILL_GATED_MODES.has(previousMode) || SKILL_GATED_MODES.has(mode)) && typeof reload === "function") {
			await reload();
		}
	}

	async cycleMode(ctx: ExtensionContext): Promise<void> {
		const idx = MODES.indexOf(this.currentMode);
		const next = MODES[(idx + 1) % MODES.length];
		await this.switchMode(next, ctx);
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
