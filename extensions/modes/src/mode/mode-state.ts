import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { MODES, MODE_META } from "./constants.js";
import { loadAgentConfig } from "./config-loader.js";
import type { Mode, ModeConfig, ModeState, PlanTitleSource } from "./types.js";
import { colored, resolveModelFromStr } from "./utils.js";

export class ModeStateManager {
	private pi: ExtensionAPI;

	currentMode: Mode = "kuafu";
	cachedConfigs: Partial<Record<Mode, ModeConfig>> = {};
	planTitle: string | undefined;
	planTitleSource: PlanTitleSource | undefined;
	planContent: string | undefined;
	pendingPlanReviewId: string | undefined;
	planReviewPending = false;
	planReviewApproved = false;
	planReviewFeedback: string | undefined;
	activeCtx: ExtensionContext | undefined;
	plannotatorAvailable: boolean | undefined;
	plannotatorUnavailableReason: string | undefined;

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

		let active: string[];

		if (config.tools || (config.extensions && config.extensions !== true)) {
			const allowed = new Set<string>();
			if (config.tools) {
				for (const t of config.tools) if (allToolNames.includes(t)) allowed.add(t);
			}
			if (Array.isArray(config.extensions)) {
				for (const t of config.extensions) if (allToolNames.includes(t)) allowed.add(t);
			} else {
				for (const t of allToolNames) allowed.add(t);
			}
			active = Array.from(allowed);
		} else {
			active = [...allToolNames];
		}

		if (config.disallowedTools?.length) {
			const denied = new Set(config.disallowedTools);
			active = active.filter((t) => !denied.has(t));
		}

		this.pi.setActiveTools(active);

		if (config.model) {
			const resolved = resolveModelFromStr(config.model, ctx.modelRegistry);
			if (resolved) {
				await this.pi.setModel(resolved);
			}
		}

		this.updateStatus(ctx);
	}

	updateStatus(ctx: ExtensionContext): void {
		const meta = MODE_META[this.currentMode];
		ctx.ui.setStatus("agent-mode", colored(this.currentMode, meta.label));
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

	resetPlanReviewState(): void {
		this.pendingPlanReviewId = undefined;
		this.planReviewPending = false;
		this.planReviewApproved = false;
		this.planReviewFeedback = undefined;
	}
}
