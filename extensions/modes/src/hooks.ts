import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { MODES, MODE_ALIASES } from "./constants.js";
import { buildPlanContextContent } from "./plan-context.js";
import type { ModeStateManager } from "./mode-state.js";
import { promptPostPlanAction, recoverPlanReview } from "./plannotator.js";
import { isDelegationAllowed, isSafeCommand } from "./utils.js";
import type { Mode, ModeState, PlanEntry } from "./types.js";

export function registerModeHooks(pi: ExtensionAPI, state: ModeStateManager): void {
	// Block invalid delegations and destructive bash in mode-specific contexts
	pi.on("tool_call", async (event) => {
		const config = state.loadConfig(state.currentMode);

		if (event.toolName === "Agent") {
			const requestedType = (event.input as { subagent_type?: string }).subagent_type ?? "";
			const delegation = isDelegationAllowed(config, requestedType);
			if (!delegation.allowed) {
				const allowedText = delegation.permittedTargets?.length
					? delegation.permittedTargets.join(", ")
					: "all except targets blocked by disallow_delegation_to";
				return {
					block: true,
					reason: `Mode ${state.currentMode}: delegation to "${requestedType}" is blocked by frontmatter policy. Allowed targets: ${allowedText}`,
				};
			}
		}

		if (state.currentMode !== "fuxi" || event.toolName !== "bash") return;
		const command = (event.input as { command?: string }).command ?? "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not read-only). Use /mode kuafu to switch to build mode first.\nCommand: ${command}`,
			};
		}
	});

	// Prompt injection via before_agent_start
	pi.on("before_agent_start", async (event) => {
		const config = state.loadConfig(state.currentMode);
		if (!config.body) return;

		// Hou Tu: inject the plan as a message on first turn after switch
		if (state.currentMode === "houtu" && state.justSwitchedToHoutu && state.planContent) {
			state.justSwitchedToHoutu = false;
			return {
				message: {
					customType: "plan-context",
					content: buildPlanContextContent(state),
					display: true,
				},
				systemPrompt: event.systemPrompt + "\n\n" + config.body,
			};
		}

		return {
			systemPrompt: event.systemPrompt + "\n\n" + config.body,
		};
	});

	// Context: strip stale Fu Xi noise when in Hou Tu mode
	pi.on("context", async (event) => {
		if (state.currentMode !== "houtu") return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as typeof m & { customType?: string };
				// Keep plan-context injection
				if (msg.customType === "plan-context") return true;
				// Strip Fu Xi planning context
				if (msg.customType === "plan-mode-context") return false;
				return true;
			}),
		};
	});

	// Post-plan prompt: after Fu Xi finishes, ask what's next
	pi.on("agent_end", async (_event, ctx) => {
		state.activeCtx = ctx;
		if (state.currentMode !== "fuxi" || !ctx.hasUI) return;
		if (state.hasPendingReview()) return;
		await promptPostPlanAction(pi, state, ctx);
	});

	// Session start: restore state
	pi.on("session_start", async (_event, ctx) => {
		state.activeCtx = ctx;

		// Tab on empty editor → cycle mode; otherwise pass through to autocomplete
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				class ModeEditor extends CustomEditor {
					handleInput(data: string): void {
						if (matchesKey(data, Key.tab) && !this.getText().trim()) {
							if (state.activeCtx) state.cycleMode(state.activeCtx);
							return;
						}
						super.handleInput(data);
					}
				}
				return new ModeEditor(tui, theme, keybindings);
			});
		}
		// Check --mode flag
		const flagValue = pi.getFlag("mode");
		if (typeof flagValue === "string" && flagValue && flagValue !== "kuafu") {
			const resolved = MODE_ALIASES[flagValue] ?? (MODES.includes(flagValue as Mode) ? (flagValue as Mode) : null);
			if (resolved) {
				state.currentMode = resolved;
			}
		}

		// Restore persisted state (unless flag overrode)
		if (!flagValue || flagValue === "kuafu") {
			const entries = ctx.sessionManager.getEntries();
			const modeEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "agent-mode")
				.pop() as { data?: ModeState } | undefined;

			if (modeEntry?.data) {
				state.currentMode = modeEntry.data.mode ?? state.currentMode;
				state.planTitle = modeEntry.data.planTitle;
				state.planContent = modeEntry.data.planContent;
				state.gapReviewApproved = modeEntry.data.gapReviewApproved ?? false;
				state.gapReviewFeedback = modeEntry.data.gapReviewFeedback;
				state.pendingPlanReviewId = modeEntry.data.planReviewId;
				state.planReviewPending = modeEntry.data.planReviewPending ?? false;
				state.planReviewApproved = modeEntry.data.planReviewApproved ?? false;
				state.planReviewFeedback = modeEntry.data.planReviewFeedback;
				state.highAccuracyReviewPending = modeEntry.data.highAccuracyReviewPending ?? false;
				state.highAccuracyReviewApproved = modeEntry.data.highAccuracyReviewApproved ?? false;
				state.highAccuracyReviewFeedback = modeEntry.data.highAccuracyReviewFeedback;
				state.planActionPending = modeEntry.data.planActionPending ?? false;
			}
		}

		if (!state.pendingPlanReviewId) {
			state.planReviewPending = false;
		}

		// Restore plan content from plan entries if not in mode state
		if (!state.planContent) {
			const entries = ctx.sessionManager.getEntries();
			const planEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan")
				.pop() as { data?: PlanEntry } | undefined;

			if (planEntry?.data?.content) {
				state.planContent = planEntry.data.content;
				state.planTitle = planEntry.data.title ?? state.planTitle;
			}
		}


		if (state.highAccuracyReviewPending) {
			state.highAccuracyReviewPending = false;
			state.planActionPending = true;
			if (ctx.hasUI) {
				ctx.ui.notify("Pending high accuracy review could not be recovered. Returning to the post-plan menu.", "warning");
			}
		}

		state.applyMode(ctx);
		await recoverPlanReview(pi, state, ctx);
		state.persistState();
		await promptPostPlanAction(pi, state, ctx);
	});

	// Session shutdown: clear context
	pi.on("session_shutdown", async () => {
		state.activeCtx = undefined;
	});
}
