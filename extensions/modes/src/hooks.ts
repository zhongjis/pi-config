import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { isTui } from "../../lib/mode.js";
import {
	hasGuardCapability,
	registerGuardScopeProvider,
	SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY,
} from "../../lib/guard-registration.js";
import { derivePlanTitleFromMarkdown, hydratePlanState, getLocalDraftPath, getLocalPlanPath, readLocalPlanFile } from "./plan-storage.js";
import { recoverPlanReview } from "./plannotator.js";
import { LOCAL_DRAFT_URI, LOCAL_PLAN_URI, MODES, MODE_ALIASES } from "./constants.js";
import { getModeSkillPaths } from "./mode-skills.js";
import type { ModeStateManager } from "./mode-state.js";
import type { Mode, ModeState } from "./types.js";


// ─── Plan write detection ────────────────────────────────────────────────────

function isPlanWriteTarget(input: unknown, planPath: string, draftPath: string): boolean {
	const path = (input as { path?: unknown })?.path;
	if (typeof path !== "string") return false;
	return path === LOCAL_PLAN_URI || path === planPath || path === LOCAL_DRAFT_URI || path === draftPath;
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}


// ─── Subagent detection ────────────────────────────────────────────────────

function isSubagentSession(ctx: ExtensionContext): boolean {
  const sm = ctx.sessionManager as any;
  if (!sm || typeof sm.getSessionFile !== "function") return false;
  const sessionFile = sm.getSessionFile();
  return typeof sessionFile === "string" && sessionFile.includes("subagent-sessions");
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

// ─── Plan state refresh ──────────────────────────────────────────────────────

async function refreshPlanStateFromLocalPlan(ctx: Parameters<typeof readLocalPlanFile>[0], state: ModeStateManager): Promise<void> {
	const content = await readLocalPlanFile(ctx);
	const title = derivePlanTitleFromMarkdown(content);
	state.planContent = content;
	state.planTitle = title;
	state.planTitleSource = title ? "content-h1" : undefined;
}

// ─── HTML comment markers for mode body injection ────────────────────────────

function modeMarkerStart(mode: Mode): string {
	return `<!-- mode:${mode} -->`;
}

function modeMarkerEnd(mode: Mode): string {
	return `<!-- /mode:${mode} -->`;
}

function stripModeBodiesFromSystemPrompt(systemPrompt: string): string {
	return systemPrompt.replace(/<!-- mode:\w+ -->[\s\S]*?<!-- \/mode:\w+ -->/g, "").trim();
}

function injectOverlays(body: string, overlays: string): string {
	// Inject overlays BEFORE <critical> section (lost-in-the-middle fix)
	const anchor = "<critical>";
	const idx = body.indexOf(anchor);
	if (idx !== -1) {
		return `${body.slice(0, idx)}${overlays}\n\n${body.slice(idx)}`;
	}
	// Fallback: inject AFTER </role> if no <critical> found
	const roleClose = "</role>";
	const roleIdx = body.indexOf(roleClose);
	if (roleIdx !== -1) {
		const insertAt = roleIdx + roleClose.length;
		return `${body.slice(0, insertAt)}\n\n${overlays}${body.slice(insertAt)}`;
	}
	// Last resort: append at end
	return `${body}\n\n${overlays}`;
}

function buildModeSystemPrompt(
	systemPrompt: string,
	state: ModeStateManager,
	config: ReturnType<ModeStateManager["loadConfig"]>,
): string {
	if (!config.body) {
		return systemPrompt;
	}

	// Apply Gemini overlays into body before wrapping
	const effectiveBody = config.overlays ? injectOverlays(config.body, config.overlays) : config.body;
	const wrappedBody = `${modeMarkerStart(state.currentMode)}\n${effectiveBody}\n${modeMarkerEnd(state.currentMode)}`;

	if (config.promptMode === "replace") {
		const strippedBasePrompt = stripModeBodiesFromSystemPrompt(systemPrompt).trimEnd();
		return strippedBasePrompt ? `${strippedBasePrompt}\n\n${wrappedBody}` : wrappedBody;
	}

	return `${systemPrompt}\n\n${wrappedBody}`;
}

// ─── Session start sub-steps ─────────────────────────────────────────────────

function setupModeEditor(ctx: ExtensionContext, state: ModeStateManager): void {
	if (!isTui(ctx)) return;

	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const BaseEditor = CustomEditor as unknown as new (...args: unknown[]) => {
			handleInput(data: string): void;
			getText(): string;
			onSubmit?: (text: string) => void | Promise<void>;
		};
		class ModeEditor extends BaseEditor {
			handleInput(data: string): void {
				if (matchesKey(data, Key.ctrlShift("m"))) {
					void this.onSubmit?.(`/mode:${state.nextMode()}`);
					return;
				}

				if (matchesKey(data, Key.tab) && !this.getText().trim()) {
					void this.onSubmit?.(`/mode:${state.nextMode()}`);
					return;
				}
				super.handleInput(data);
			}
		}
		return new ModeEditor(tui, theme, keybindings) as any;
	});
}

function resolveInitialMode(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): void {
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
			state.awaitingUserAction = modeEntry.data.awaitingUserAction;
			state.planReviewApproved = modeEntry.data.planReviewApproved ?? false;
			state.planReviewFeedback = modeEntry.data.planReviewFeedback;
			state.modelOverride = modeEntry.data.modelOverride;
		}
	}
	if (!state.pendingPlanReviewId) {
		state.planReviewPending = false;
		state.clearAwaitingUserAction("plannotator-review");
	}
}

// ─── Hook registration ───────────────────────────────────────────────────────

export function registerModeGuardScope(pi: ExtensionAPI, state: ModeStateManager): void {
	registerGuardScopeProvider(pi, "modes:fuxi", () => state.currentMode === "fuxi" ? "guard" : "abstain");
}

export function registerModeHooks(pi: ExtensionAPI, state: ModeStateManager): void {
	pi.on("tool_call", async (event, ctx) => {

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

		if (event.toolName === "bash" && !hasGuardCapability(pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)) {
			return {
				block: true,
				reason: "Plan mode: built-in bash blocked because smart guard capability is not registered.",
			};
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (state.currentMode !== "fuxi") return;

		const planPath = getLocalPlanPath(ctx);
		if (!isSuccessfulPlanMutationResult(event, planPath)) return;

		await refreshPlanStateFromLocalPlan(ctx, state);
		// Only reset review state if no review is actively pending — a plan write
		// during an active browser review should NOT nuke the pending review.
		if (!state.planReviewPending) {
			state.resetPlanReviewState();
		}
		// Reset availability cache so the approval menu re-probes plannotator
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;
	});

	pi.on("resources_discover", async () => {
		return { skillPaths: getModeSkillPaths(state.currentMode) };
	});

	function bindActiveSessionContext(ctx: ExtensionContext): void {
		state.activeCtx = ctx;
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		state.activeCtx = ctx;
		if (isSubagentSession(ctx)) return; // subagents have their own model config
		// First pass: load default config to get model spec from frontmatter
		const baseConfig = state.loadConfig(state.currentMode);

		// Apply model from config — this sets state.resolvedFamily based on resolved model
		await state.applyModelFromConfig(baseConfig, ctx);

		// Second pass: reload with resolved family (picks up gpt.md body or gemini.md overlays)
		const config = state.loadConfig(state.currentMode, state.resolvedFamily);

		const systemPrompt = buildModeSystemPrompt(event.systemPrompt, state, config);
		if (!config.body) return;
		return { systemPrompt };
	});

	pi.on("agent_end", async (_event, ctx) => {
		bindActiveSessionContext(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") {
			const config = state.loadConfig(state.currentMode);
			await state.applyModelFromConfig(config, ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		bindActiveSessionContext(ctx);

		if (isSubagentSession(ctx)) {
			// Subagents self-configure from their own agent frontmatter.
			// Skip mode model/tool overrides but keep editor + plan state.
			setupModeEditor(ctx, state);
			resolveInitialMode(pi, state, ctx);
			await hydratePlanState(ctx as any, state);
			await recoverPlanReview(pi, state, ctx);
			state.persistState();
			return;
		}

		setupModeEditor(ctx, state);
		resolveInitialMode(pi, state, ctx);

		await hydratePlanState(ctx as any, state);
		await state.applyMode(ctx);
		await recoverPlanReview(pi, state, ctx);
		state.persistState();
	});

	pi.on("session_switch" as any, async (_event: any, ctx: ExtensionContext) => {
		bindActiveSessionContext(ctx);
	});

	pi.on("session_tree" as any, async (_event: any, ctx: ExtensionContext) => {
		bindActiveSessionContext(ctx);
	});

	pi.on("session_shutdown", async () => {
		state.activeCtx = undefined;
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;
	});
}
