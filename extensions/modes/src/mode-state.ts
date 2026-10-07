import { GOAL_TOOL_NAMES, goalToolAccess } from "../../goal/src/goal/access.js";
import type { RuntimeModelCandidate } from "../../lib/runtime-model-fallback.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertFastSupported, readFastPolicy, type FastPolicyEntry } from "../../lib/fast.js";
import { type AccessDiagnostic, resolveToolAccess, selectActiveToolNames, toolCandidates } from "../../lib/active-tools.js";
import { MODES, MODE_COLORS, MODE_META, MODE_TOOL_CEILING_NAME, RESET } from "./constants.js";
import { getModeSkillPaths } from "./mode-skills.js";
import { loadAgentConfig } from "./config-loader.js";
import { getModePromptSource } from "../../lib/model-family.js";
import { parseModelChain, resolveFirstAvailable, resolveModel } from "../../lib/model-selection.js";
import type { AwaitingUserActionState, Mode, ModeConfig, ModeState, PlanTitleSource, VersionedDelegationPolicy } from "./types.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

function colored(mode: Mode, text: string): string {
	return `${MODE_COLORS[mode]}${text}${RESET}`;
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
	thinkingOverride?: ThinkingLevel;
	appliedThinkingLevel?: ThinkingLevel;
	applyingModelConfig = false;
	resolvedFamily: "gpt" | "gemini" | "default" = "default";
	/** Goal tools Goal access allowed at the last tool-access apply. */
	allowedGoalTools: readonly string[] = [];
	private notifiedToolDiagnostics = new Set<string>();
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
			thinkingOverride: this.thinkingOverride,
			delegationPolicy: delegationPolicyFromConfig(this.loadConfig(this.currentMode)),
		});
	}

	loadConfig(mode: Mode, family?: "gpt" | "gemini" | "default"): ModeConfig {
		const cacheKey = `${mode}:${family ?? "default"}`;
		if (!this.cachedConfigs[cacheKey]) {
			this.cachedConfigs[cacheKey] = loadAgentConfig(mode, family) ?? { body: "", toolRules: [] };
		}
		return this.cachedConfigs[cacheKey]!;
	}

	async applyMode(ctx: ExtensionContext, resetFast = false): Promise<void> {
		const config = this.loadConfig(this.currentMode);
		await this.applyModelFromConfig(config, ctx, resetFast);
		await this.applyToolAccess(ctx);
		this.updateStatus(ctx);
	}

	/** Resolve the current mode's `tools:` rules against the live registry, then the hard gates. */
	toolAccess(allowedGoals: readonly string[] = this.allowedGoalTools): { allowed: Set<string>; diagnostics: AccessDiagnostic[] } {
		const config = this.loadConfig(this.currentMode);
		return resolveToolAccess(config.toolRules, toolCandidates(this.pi.getAllTools()), {
			allowNesting: config.allowNesting === true,
			goalTools: { names: GOAL_TOOL_NAMES, allowed: allowedGoals },
			planTools: this.currentMode === "fuxi",
		});
	}

	/** Allowed tool names for the mode tool ceiling, using the Goal access cached at the last apply. */
	allowedToolNames(): ReadonlySet<string> {
		return this.toolAccess().allowed;
	}

	/** Whether a call may run; Goal tool calls re-read Goal access instead of the cache. */
	async isToolCallAllowed(ctx: ExtensionContext, toolName: string): Promise<boolean> {
		const isGoalTool = GOAL_TOOL_NAMES.some((goalName) => goalName === toolName);
		const allowedGoals = isGoalTool ? await goalToolAccess(ctx) : this.allowedGoalTools;
		return this.toolAccess(allowedGoals).allowed.has(toolName);
	}

	async applyToolAccess(ctx: ExtensionContext): Promise<void> {
		const allTools = this.pi.getAllTools();
		const registered = new Set(allTools.map((t) => t.name));
		const goalNames = GOAL_TOOL_NAMES.filter((name) => registered.has(name));
		this.allowedGoalTools = goalNames.length ? await goalToolAccess(ctx) : [];

		const { allowed, diagnostics } = this.toolAccess();
		const configErrors = this.loadConfig(this.currentMode).errors ?? [];
		this.notifyToolDiagnostics(ctx, [...configErrors.map((message) => ({ severity: "error" as const, message })), ...diagnostics]);

		const activeToolNames = this.pi.getActiveTools().filter((name) => registered.has(name));
		// Allowed Goal tools are deferred; listing them as current activates them.
		const nextActiveToolNames = selectActiveToolNames(allTools, allowed, [
			...activeToolNames,
			...goalNames.filter((name) => allowed.has(name)),
		]);
		if (registered.has(MODE_TOOL_CEILING_NAME) && !nextActiveToolNames.includes(MODE_TOOL_CEILING_NAME)) {
			nextActiveToolNames.push(MODE_TOOL_CEILING_NAME);
		}
		if (!sameToolSet(nextActiveToolNames, activeToolNames)) {
			this.pi.setActiveTools(nextActiveToolNames);
		}
	}

	private notifyToolDiagnostics(ctx: ExtensionContext, diagnostics: readonly AccessDiagnostic[]): void {
		for (const diagnostic of diagnostics) {
			const key = `${this.currentMode}\0${diagnostic.message}`;
			if (this.notifiedToolDiagnostics.has(key)) continue;
			this.notifiedToolDiagnostics.add(key);
			ctx.ui.notify(`Mode ${this.currentMode} tools: ${diagnostic.message}`, diagnostic.severity === "error" ? "error" : "warning");
		}
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
		const previous = readFastPolicy(ctx.sessionManager?.getBranch?.() ?? [], ctx.sessionManager?.getEntries?.());
		const initializeFast = resetFast || !previous || (previous.source === "mode" && previous.mode !== this.currentMode);
		if (!resolved) {
			if (initializeFast) this.persistFastDefault(ctx, false);
			return;
		}

		// Guard 2: skip setModel if already the active model.
		const current = ctx.model;
		const sameModel =
			current && current.provider === resolved.model.provider && current.id === resolved.model.id && current.api === resolved.model.api;
		if (resolved.fast && (initializeFast || !sameModel)) assertFastSupported(resolved.model, ctx.modelRegistry.isUsingOAuth(resolved.model));
		const targetLevel = this.thinkingOverride ?? resolved.thinkingLevel;
		this.appliedThinkingLevel = targetLevel;
		this.applyingModelConfig = true;
		try {
			if (!sameModel && await this.pi.setModel(resolved.model) === false) throw new Error(`Could not apply mode model: ${modelSpec}`);
			this.resolvedFamily = getModePromptSource(resolved.model);
			if (initializeFast) this.persistFastDefault(ctx, resolved.fast === true);
			// Guard 3: skip setThinkingLevel if already at that level.
			// setModel() internally preserves current level for reasoning-capable models, so
			// on same-model paths the prior level is retained and this guard short-circuits.
			if (targetLevel && targetLevel !== this.pi.getThinkingLevel()) {
				this.pi.setThinkingLevel(targetLevel);
			}
		} finally {
			this.applyingModelConfig = false;
		}
	}

	applyRuntimeModel(candidate: RuntimeModelCandidate, ctx: ExtensionContext): void {
		this.resolvedFamily = getModePromptSource(candidate.model);
		this.persistFastDefault(ctx, candidate.fast === true);
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
		// Reload only when the mode's discovered skill set actually changes; static
		// gating drifts if a skills/ dir is later added to another mode.
		const skillsChanged = !sameToolSet(getModeSkillPaths(previousMode), getModeSkillPaths(mode));
		return mode !== previousMode && skillsChanged;
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
