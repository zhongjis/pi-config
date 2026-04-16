import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { derivePlanTitleFromMarkdown, hydratePlanState } from "../mode-planning/plan-storage.js";
import { getLocalDraftPath, getLocalPlanPath, LOCAL_DRAFT_URI, LOCAL_PLAN_URI, readLocalPlanFile } from "../mode-planning/plan-local.js";
import { recoverPlanReview } from "../mode-planning/plannotator.js";
import { MODES, MODE_ALIASES } from "./constants.js";
import type { ModeStateManager } from "./mode-state.js";
import type { Mode, ModeState } from "./types.js";
import { isDelegationAllowed, isSafeCommand } from "./utils.js";

function isPlanWriteTarget(input: unknown, planPath: string, draftPath: string): boolean {
	const path = (input as { path?: unknown })?.path;
	if (typeof path !== "string") return false;
	return path === LOCAL_PLAN_URI || path === planPath || path === LOCAL_DRAFT_URI || path === draftPath;
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

async function refreshPlanStateFromLocalPlan(ctx: Parameters<typeof readLocalPlanFile>[0], state: ModeStateManager): Promise<void> {
	const content = await readLocalPlanFile(ctx);
	const title = derivePlanTitleFromMarkdown(content);
	state.planContent = content;
	state.planTitle = title;
	state.planTitleSource = title ? "content-h1" : undefined;
}

function stripModeBodiesFromSystemPrompt(systemPrompt: string, state: ModeStateManager): string {
	let stripped = systemPrompt;

	for (const mode of MODES) {
		const body = state.loadConfig(mode).body.trim();
		if (!body) continue;

		const prefixedBody = `\n\n${body}`;
		while (stripped.includes(prefixedBody)) {
			stripped = stripped.replace(prefixedBody, "");
		}

		if (stripped === body) {
			stripped = "";
		}
	}

	return stripped;
}

function buildModeSystemPrompt(
	systemPrompt: string,
	state: ModeStateManager,
	config: ReturnType<ModeStateManager["loadConfig"]>,
): string {
	if (!config.body) {
		return systemPrompt;
	}

	if (config.promptMode === "replace") {
		const strippedBasePrompt = stripModeBodiesFromSystemPrompt(systemPrompt, state).trimEnd();
		return strippedBasePrompt ? `${strippedBasePrompt}\n\n${config.body}` : config.body;
	}

	return `${systemPrompt}\n\n${config.body}`;
}

export function registerModeHooks(pi: ExtensionAPI, state: ModeStateManager): void {
	pi.on("tool_call", async (event, ctx) => {
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
			const planPath = getLocalPlanPath(ctx);
			const draftPath = getLocalDraftPath(ctx);
			if (!isPlanWriteTarget(event.input, planPath, draftPath)) {
				const path = (event.input as { path?: unknown })?.path;
				const target = typeof path === "string" && path ? path : "<missing path>";
				return {
					block: true,
					reason: `Plan mode: ${event.toolName} is restricted to ${LOCAL_PLAN_URI} or ${LOCAL_DRAFT_URI}. Target: ${target}`,
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

		const planPath = getLocalPlanPath(ctx);
		if (!isSuccessfulPlanMutationResult(event, planPath)) return;

		await refreshPlanStateFromLocalPlan(ctx, state);
		state.resetPlanReviewState();
		// Reset availability cache so the approval menu re-probes plannotator
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;
		state.persistState();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		state.activeCtx = ctx;
		const config = state.loadConfig(state.currentMode);
		const systemPrompt = buildModeSystemPrompt(event.systemPrompt, state, config);
		if (!config.body) return;
		return { systemPrompt };
	});

	pi.on("agent_end", async (_event, ctx) => {
		state.activeCtx = ctx;
	});

	pi.on("session_start", async (_event, ctx) => {
		state.activeCtx = ctx;
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;

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
				return new ModeEditor(tui, theme, keybindings) as any;
			});
		}

		const flagValue = pi.getFlag("mode");
		if (typeof flagValue === "string" && flagValue && flagValue !== "kuafu") {
			const resolved = MODE_ALIASES[flagValue] ?? (MODES.includes(flagValue as Mode) ? (flagValue as Mode) : null);
			if (resolved) {
				state.currentMode = resolved;
			}
		}

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
				state.pendingPlanReviewId = modeEntry.data.planReviewId;
				state.planReviewPending = modeEntry.data.planReviewPending ?? false;
				state.planReviewApproved = modeEntry.data.planReviewApproved ?? false;
				state.planReviewFeedback = modeEntry.data.planReviewFeedback;
			}
		}
		if (!state.pendingPlanReviewId) {
			state.planReviewPending = false;
		}

		await hydratePlanState(ctx as any, state);
		state.applyMode(ctx);
		await recoverPlanReview(pi, state, ctx);
		state.persistState();
	});

	pi.on("session_shutdown", async () => {
		state.activeCtx = undefined;
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;
	});
}
