import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { MODES, MODE_COLORS, MODE_META, RESET } from "./constants.js";
import { loadAgentConfig } from "./config-loader.js";
import { parseModelChain, resolveFirstAvailable, resolveModel } from "../../lib/model.js";
import type { AwaitingUserActionState, Mode, ModeConfig, ModeState, PlanTitleSource } from "./types.js";

function colored(mode: Mode, text: string): string {
	return `${MODE_COLORS[mode]}${text}${RESET}`;
}

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function isExtensionTool(toolName: string): boolean {
	return !BUILTIN_TOOL_NAMES.has(toolName);
}

function configAllowsReadonlyBash(config: ModeConfig): boolean {
	return Array.isArray(config.extensions) && config.extensions.includes("readonly_bash");
}

function canAddExtensionTool(toolName: string, config: ModeConfig): boolean {
	return toolName !== "readonly_bash" || configAllowsReadonlyBash(config);
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
	cachedConfigs: Partial<Record<Mode, ModeConfig>> = {};
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
		});
	}

	loadConfig(mode: Mode): ModeConfig {
		if (!this.cachedConfigs[mode]) {
			this.cachedConfigs[mode] = loadAgentConfig(mode) ?? { body: "" };
		}
		return this.cachedConfigs[mode]!;
	}

	async applyMode(ctx: ExtensionContext): Promise<void> {
		const config = this.loadConfig(this.currentMode);
		const allToolNames = this.pi.getAllTools().map((t) => t.name);
		const activeToolNames = this.pi.getActiveTools().filter((t) => allToolNames.includes(t));

		let active: string[] | undefined;

		if (config.tools) {
			const allowed = new Set<string>();
			for (const t of config.tools) if (allToolNames.includes(t) && canAddExtensionTool(t, config)) allowed.add(t);

			if (config.extensions !== false) {
				const extensionTools = Array.isArray(config.extensions)
					? config.extensions
					: activeToolNames.filter(isExtensionTool);
				for (const t of extensionTools) if (allToolNames.includes(t) && canAddExtensionTool(t, config)) allowed.add(t);
			}

			active = Array.from(allowed);
		} else if (config.extensions !== undefined) {
			const allowed = new Set(activeToolNames.filter((t) => BUILTIN_TOOL_NAMES.has(t)));
			if (config.extensions !== false) {
				const extensionTools = Array.isArray(config.extensions)
					? config.extensions
					: activeToolNames.filter(isExtensionTool);
				for (const t of extensionTools) if (allToolNames.includes(t) && canAddExtensionTool(t, config)) allowed.add(t);
			}
			active = Array.from(allowed);
		} else if (config.disallowedTools?.length) {
			active = activeToolNames;
		}

		if (active && config.disallowedTools?.length) {
			const denied = new Set(config.disallowedTools);
			active = active.filter((t) => !denied.has(t));
		}

		if (!configAllowsReadonlyBash(config)) {
			const source = active ?? activeToolNames;
			const filtered = source.filter((t) => t !== "readonly_bash");
			if (filtered.length !== source.length) active = filtered;
		}

		// Guard 1: skip setActiveTools when unchanged — avoids redundant system-prompt rebuild.
		if (active && !sameToolSet(active, activeToolNames)) {
			this.pi.setActiveTools(active);
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
		if (!config.model) return;
		const candidates = parseModelChain(config.model);
		const resolved = resolveFirstAvailable(candidates, ctx.modelRegistry);
		if (!resolved) return;

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
		this.currentMode = mode;
		this.cachedConfigs = {};
		await this.applyMode(ctx);
		this.persistState();
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
