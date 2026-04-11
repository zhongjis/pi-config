import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { MODES, MODE_ALIASES } from "./constants.js";
import { buildPlanContextContent } from "./plan-context.js";
import type { ModeStateManager } from "./mode-state.js";
import { derivePlanTitleFromMarkdown, hydratePlanState, LOCAL_PLAN_URI } from "./plan-storage.js";
import { promptPostPlanAction, recoverPlanReview } from "./plannotator.js";
import type { Mode, ModeState } from "./types.js";
import { isDelegationAllowed, isSafeCommand } from "./utils.js";
import { getPlanPath, readPlanFile } from "../../local-plan-tools/storage.js";

const LOCAL_URI_PREFIX = "local://";

function isLocalWriteTarget(input: unknown): boolean {
	const path = (input as { path?: unknown })?.path;
	return typeof path === "string" && path.startsWith(LOCAL_URI_PREFIX);
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isSuccessfulPlanMutationResult(event: {
	toolName: string;
	input?: unknown;
	details?: unknown;
	isError?: boolean;
}, planPath: string): boolean {
	if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) {
		return false;
	}

	const details = event.details && typeof event.details === "object" ? (event.details as Record<string, unknown>) : undefined;
	const localPath = getString(details?.localPath);
	if (localPath) {
		return localPath === LOCAL_PLAN_URI;
	}

	const backingPath = getString(details?.backingPath) ?? getString(details?.resolvedPath);
	if (backingPath) {
		return backingPath === planPath;
	}

	const inputPath = getString((event.input as { path?: unknown } | undefined)?.path);
	return inputPath === planPath;
}

async function refreshPlanStateFromLocalPlan(ctx: Parameters<typeof readPlanFile>[0], state: ModeStateManager): Promise<void> {
	const content = await readPlanFile(ctx);
	const title = derivePlanTitleFromMarkdown(content);
	state.planContent = content;
	state.planTitle = title;
	state.planTitleSource = title ? "content-h1" : undefined;
}

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

		if (state.currentMode !== "fuxi") return;

		if (event.toolName === "write" || event.toolName === "edit") {
			if (!isLocalWriteTarget(event.input)) {
				const path = (event.input as { path?: unknown })?.path;
				const target = typeof path === "string" && path ? path : "<missing path>";
				return {
					block: true,
					reason: `Plan mode: ${event.toolName} is restricted to local:// targets. Use path="local://PLAN.md" for plan authoring. Target: ${target}`,
				};
			}
			return;
		}

		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: string }).command ?? "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not read-only). Use /mode kuafu to switch to build mode first.\nCommand: ${command}`,
			};
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (state.currentMode !== "fuxi") return;

		const planPath = getPlanPath(ctx);
		if (!isSuccessfulPlanMutationResult(event, planPath)) return;

		await refreshPlanStateFromLocalPlan(ctx, state);
		state.resetPlanReviewState();
		state.persistState();
	});

	// Prompt injection via before_agent_start
	pi.on("before_agent_start", async (event, ctx) => {
		const config = state.loadConfig(state.currentMode);
		const systemPrompt = config.body ? `${event.systemPrompt}\n\n${config.body}` : event.systemPrompt;

		// Hou Tu: inject the plan as a message on first turn after switch
		if (state.currentMode === "houtu" && state.justSwitchedToHoutu) {
			await hydratePlanState(ctx, state);
			state.justSwitchedToHoutu = false;
			if (state.planContent) {
				return {
					message: {
						customType: "plan-context",
						content: buildPlanContextContent(state),
						display: true,
					},
					systemPrompt,
				};
			}
		}

		if (!config.body) return;
		return { systemPrompt };
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
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;

		// Tab on empty editor → cycle mode; otherwise pass through to autocomplete
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const BaseEditor = CustomEditor as unknown as new (...args: unknown[]) => {
					handleInput(data: string): void;
					getText(): string;
				};
				class ModeEditor extends BaseEditor {
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
				state.planTitleSource = modeEntry.data.planTitleSource;
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

		if (state.highAccuracyReviewPending) {
			state.highAccuracyReviewPending = false;
			state.planActionPending = true;
			if (ctx.hasUI) {
				ctx.ui.notify("Pending high accuracy review could not be recovered. Returning to the post-plan menu.", "warning");
			}
		}

		await hydratePlanState(ctx, state);

		state.applyMode(ctx);
		await recoverPlanReview(pi, state, ctx);
		state.persistState();
		await promptPostPlanAction(pi, state, ctx);
	});

	// Session shutdown: clear context
	pi.on("session_shutdown", async () => {
		state.activeCtx = undefined;
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;
	});
}
