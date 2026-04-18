import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { derivePlanTitleFromMarkdown, hydratePlanState, getLocalDraftPath, getLocalPlanPath, readLocalPlanFile } from "./plan-storage.js";
import { recoverPlanReview } from "./plannotator.js";
import { LOCAL_DRAFT_URI, LOCAL_PLAN_URI, MODES, MODE_ALIASES, SAFE_BASH_PREFIXES } from "./constants.js";
import type { ModeStateManager } from "./mode-state.js";
import { resolveModelFromStr } from "./mode-state.js";
import type { Mode, ModeConfig, ModeState } from "./types.js";

// ─── Absorbed helpers ────────────────────────────────────────────────────────

function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	return SAFE_BASH_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function dedupeCaseInsensitive(values: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const value of values) {
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(value);
	}
	return deduped;
}

function getPermittedDelegationTargets(
	config: Pick<ModeConfig, "allowDelegationTo" | "disallowDelegationTo">,
): string[] | undefined {
	if (!config.allowDelegationTo?.length) return undefined;

	const allowlisted = dedupeCaseInsensitive(config.allowDelegationTo);
	if (!config.disallowDelegationTo?.length) {
		return allowlisted;
	}

	const disallowed = new Set(
		config.disallowDelegationTo.map((value) => value.toLowerCase()),
	);
	return allowlisted.filter((value) => !disallowed.has(value.toLowerCase()));
}

function isDelegationAllowed(
	config: Pick<ModeConfig, "allowDelegationTo" | "disallowDelegationTo">,
	target: string,
): {
	allowed: boolean;
	permittedTargets?: string[];
} {
	const normalizedTarget = target.trim().toLowerCase();

	const permittedTargets = getPermittedDelegationTargets(config);
	if (permittedTargets) {
		return {
			allowed: permittedTargets.some(
				(value) => value.toLowerCase() === normalizedTarget,
			),
			permittedTargets,
		};
	}

	if (config.disallowDelegationTo?.length) {
		return {
			allowed: !config.disallowDelegationTo.some(
				(value) => value.toLowerCase() === normalizedTarget,
			),
		};
	}

	return { allowed: true };
}

// ─── Plan write detection ────────────────────────────────────────────────────

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

function buildModeSystemPrompt(
	systemPrompt: string,
	state: ModeStateManager,
	config: ReturnType<ModeStateManager["loadConfig"]>,
): string {
	if (!config.body) {
		return systemPrompt;
	}

	const wrappedBody = `${modeMarkerStart(state.currentMode)}\n${config.body}\n${modeMarkerEnd(state.currentMode)}`;

	if (config.promptMode === "replace") {
		const strippedBasePrompt = stripModeBodiesFromSystemPrompt(systemPrompt).trimEnd();
		return strippedBasePrompt ? `${strippedBasePrompt}\n\n${wrappedBody}` : wrappedBody;
	}

	return `${systemPrompt}\n\n${wrappedBody}`;
}

// ─── Session start sub-steps ─────────────────────────────────────────────────

function setupModeEditor(ctx: ExtensionContext, state: ModeStateManager): void {
	if (!ctx.hasUI) return;

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
			state.planReviewApproved = modeEntry.data.planReviewApproved ?? false;
			state.planReviewFeedback = modeEntry.data.planReviewFeedback;
		}
	}
	if (!state.pendingPlanReviewId) {
		state.planReviewPending = false;
	}
}

// ─── Hook registration ───────────────────────────────────────────────────────

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

		if (config.model) {
			const resolved = resolveModelFromStr(config.model, ctx.modelRegistry);
			if (resolved) {
				await pi.setModel(resolved);
			}
		}

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

		setupModeEditor(ctx, state);
		resolveInitialMode(pi, state, ctx);

		await hydratePlanState(ctx as any, state);
		await state.applyMode(ctx);
		await recoverPlanReview(pi, state, ctx);
		state.persistState();
	});

	pi.on("session_shutdown", async () => {
		state.activeCtx = undefined;
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;
	});
}
