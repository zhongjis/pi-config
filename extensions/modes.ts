/**
 * Agent Modes Extension
 *
 * Three personas — Kua Fu 夸父 (build), Fu Xi 伏羲 (plan), Hou Tu 后土 (execute).
 * Default: Kua Fu. Switch via /mode, --mode flag, or Ctrl+Shift+M.
 *
 * Each mode reads its prompt from agents/<mode>.md (same files used by subagent).
 * AGENTS.md global rules stay active in all modes.
 *
 * Plan flow:
 *   Fu Xi writes plan via plan_write tool → session entry
 *   exit_plan_mode finalizes → user picks Execute/Refine/Stay
 *   Execute → Hou Tu mode, plan injected via before_agent_start
 *   context event strips Fu Xi noise for Hou Tu
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = "kuafu" | "fuxi" | "houtu";

interface ModeConfig {
	body: string;
	tools?: string[];
	extensions?: string[] | true;
	disallowedTools?: string[];
}

interface ModeState {
	mode: Mode;
	planTitle?: string;
	planContent?: string;
	planReviewId?: string;
	planReviewPending?: boolean;
	planReviewApproved?: boolean;
	planReviewFeedback?: string;
	planActionPending?: boolean;
}

interface PlanEntry {
	title?: string;
	content: string;
	draft: boolean;
}

interface PlannotatorPlanReviewPayload {
	planContent: string;
	planFilePath?: string;
	origin?: string;
}

interface PlannotatorPlanReviewStartResult {
	status: "pending";
	reviewId: string;
}

interface PlannotatorReviewResultEvent {
	reviewId: string;
	approved: boolean;
	feedback?: string;
}

type PlannotatorReviewStatusResult =
	| { status: "pending" }
	| ({ status: "completed" } & PlannotatorReviewResultEvent)
	| { status: "missing" };

type PlannotatorResponse<T> =
	| { status: "handled"; result: T }
	| { status: "unavailable"; error?: string }
	| { status: "error"; error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODES: Mode[] = ["kuafu", "fuxi", "houtu"];

const MODE_ALIASES: Record<string, Mode> = {
	build: "kuafu",
	plan: "fuxi",
	execute: "houtu",
};

const MODE_META: Record<Mode, { alias: string; label: string }> = {
	kuafu: { alias: "build", label: "kuafu (build)" },
	fuxi: { alias: "plan", label: "fuxi (plan)" },
	houtu: { alias: "execute", label: "houtu (execute)" },
};

// Color scheme (24-bit ANSI)
const MODE_COLORS: Record<Mode, string> = {
	kuafu: "\x1b[38;2;0;206;209m",   // #00CED1 — dark turquoise (夸父)
	fuxi: "\x1b[38;2;255;87;34m",    // #FF5722 — deep orange/fire (伏羲)
	houtu: "\x1b[38;2;16;185;129m",
};
const RESET = "\x1b[0m";
const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
const PLANNOTATOR_REVIEW_RESULT_CHANNEL = "plannotator:review-result";
const PLANNOTATOR_TIMEOUT_MS = 5000;

function colored(mode: Mode, text: string): string {
	return `${MODE_COLORS[mode]}${text}${RESET}`;
}

// Read-only bash commands allowed in Fu Xi (plan) mode
const SAFE_BASH_PREFIXES = [
	"cat ", "head ", "tail ", "less ", "more ",
	"grep ", "rg ", "find ", "fd ", "fzf ",
	"ls ", "ls\n", "pwd", "tree ", "tree\n",
	"git status", "git log", "git diff", "git branch", "git show", "git remote",
	"git rev-parse", "git describe", "git tag",
	"npm list", "npm outdated", "npm info", "npm view", "npm ls",
	"yarn info", "yarn list", "yarn why",
	"pnpm list", "pnpm outdated", "pnpm why",
	"uname", "whoami", "date", "uptime", "which ", "command -v",
	"wc ", "sort ", "uniq ", "cut ", "awk ", "sed -n", "jq ",
	"file ", "stat ", "du ", "df ",
	"echo ", "printf ",
	"nix ", "nh ",
];

function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	return SAFE_BASH_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (self-contained, same semantics as subagent extension)
// ---------------------------------------------------------------------------

function parseCsv(val: unknown): string[] | undefined {
	if (val === undefined || val === null) return undefined;
	const s = String(val).trim();
	if (!s || s.toLowerCase() === "none") return undefined;
	return s.split(",").map((v) => v.trim()).filter(Boolean);
}

function parseInheritField(val: unknown): true | string[] | undefined {
	if (val === undefined || val === null || val === true) return undefined;
	if (val === false || val === "none") return undefined;
	const items = parseCsv(val);
	return items && items.length > 0 ? items : undefined;
}

// ---------------------------------------------------------------------------
// Prompt + config loading
// ---------------------------------------------------------------------------

function loadAgentConfig(mode: Mode): ModeConfig | null {
	const globalPath = join(homedir(), ".pi", "agent", "agents", `${mode}.md`);

	if (!existsSync(globalPath)) return null;

	try {
		const content = readFileSync(globalPath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const trimmedBody = body.trim();
		if (!trimmedBody) return null;

		return {
			body: trimmedBody,
			tools: parseCsv(frontmatter.tools),
			extensions: parseInheritField(frontmatter.extensions) ?? (frontmatter.extensions === true ? true : undefined),
			disallowedTools: parseCsv(frontmatter.disallowed_tools),
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function modesExtension(pi: ExtensionAPI): void {
	let currentMode: Mode = "kuafu";
	let cachedConfigs: Partial<Record<Mode, ModeConfig>> = {};
	let planTitle: string | undefined;
	let planContent: string | undefined;
	let pendingPlanReviewId: string | undefined;
	let planReviewPending = false;
	let planReviewApproved = false;
	let planReviewFeedback: string | undefined;
	let planActionPending = false;
	let justSwitchedToHoutu = false;
	let activeCtx: ExtensionContext | undefined;

	// -----------------------------------------------------------------------
	// State helpers
	// -----------------------------------------------------------------------

	function persistState(): void {
		pi.appendEntry<ModeState>("agent-mode", {
			mode: currentMode,
			planTitle,
			planContent,
			planReviewId: pendingPlanReviewId,
			planReviewPending,
			planReviewApproved,
			planReviewFeedback,
			planActionPending,
		});
	}

	function loadConfig(mode: Mode): ModeConfig {
		if (!cachedConfigs[mode]) {
			cachedConfigs[mode] = loadAgentConfig(mode) ?? { body: "" };
		}
		return cachedConfigs[mode]!;
	}

	function applyMode(ctx: ExtensionContext): void {
		const config = loadConfig(currentMode);
		const allToolNames = pi.getAllTools().map((t) => t.name);

		let active: string[];

		if (config.tools || (config.extensions && config.extensions !== true)) {
			// Explicit allowlist mode (e.g. fuxi): build set from tools + extensions
			const allowed = new Set<string>();
			if (config.tools) {
				for (const t of config.tools) if (allToolNames.includes(t)) allowed.add(t);
			}
			if (Array.isArray(config.extensions)) {
				for (const t of config.extensions) if (allToolNames.includes(t)) allowed.add(t);
			} else {
				// extensions not specified or true → add all available tools
				for (const t of allToolNames) allowed.add(t);
			}
			active = Array.from(allowed);
		} else {
			// No allowlist → start with everything (e.g. kuafu, houtu)
			active = [...allToolNames];
		}

		// Apply denylist (disallowed_tools frontmatter)
		if (config.disallowedTools?.length) {
			const denied = new Set(config.disallowedTools);
			active = active.filter((t) => !denied.has(t));
		}

		// Note: tools.ts may override this via persisted /tools selections (load order)
		pi.setActiveTools(active);
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const alias = MODE_META[currentMode].alias;
		ctx.ui.setStatus("agent-mode", `${colored(currentMode, currentMode)} \x1b[2m(${alias})\x1b[0m`);
	}

	function switchMode(mode: Mode, ctx: ExtensionContext): void {
		currentMode = mode;
		cachedConfigs = {}; // force reload on switch
		applyMode(ctx);
		persistState();
	}
	function resetPlanReviewState(): void {
		pendingPlanReviewId = undefined;
		planReviewPending = false;
		planReviewApproved = false;
		planReviewFeedback = undefined;
		planActionPending = false;
	}

	function buildPlanContextContent(): string {
		if (!planContent) return "";
		const notes = planReviewFeedback?.trim();
		return notes
			? `[ACTIVE PLAN: ${planTitle ?? "untitled"}]\n\n${planContent}\n\n[REVIEWER NOTES]\n${notes}`
			: `[ACTIVE PLAN: ${planTitle ?? "untitled"}]\n\n${planContent}`;
	}

	function buildRefinementMessage(): string {
		const feedback = planReviewFeedback?.trim();
		if (feedback) {
			return `Plannotator review feedback:\n${feedback}\n\nPlease revise the current plan and resubmit it.`;
		}
		return "Please revise the current plan based on the Plannotator review feedback and resubmit it.";
	}

	async function requestPlannotator<T>(
		action: "plan-review" | "review-status",
		payload: Record<string, unknown>,
	): Promise<PlannotatorResponse<T>> {
		const requestId = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		return await new Promise<PlannotatorResponse<T>>((resolve) => {
			let settled = false;
			const timeoutId = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve({ status: "unavailable", error: "Plannotator request timed out." });
			}, PLANNOTATOR_TIMEOUT_MS);

			pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
				requestId,
				action,
				payload,
				respond: (response: PlannotatorResponse<T>) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeoutId);
					resolve(response);
				},
			});
		});
	}

	async function promptPostPlanAction(ctx: ExtensionContext): Promise<void> {
		if (currentMode !== "fuxi" || !ctx.hasUI) return;
		if (!planContent || !planTitle || !planReviewApproved || !planActionPending) return;

		const choice = await ctx.ui.select(`Plan "${planTitle}" ready. What next?`, [
			"Execute the plan (switch to Hou Tu)",
			"Stay in plan mode",
			"Refine the plan",
		]);
		if (!choice) return;

		if (choice.startsWith("Execute")) {
			planActionPending = false;
			persistState();
			justSwitchedToHoutu = true;
			switchMode("houtu", ctx);
			pi.sendUserMessage(`Execute the plan: ${planTitle}`, { deliverAs: "followUp" });
			return;
		}

		if (choice.startsWith("Refine")) {
			const refinement = await ctx.ui.editor("Refine the plan:", planReviewFeedback ?? "");
			if (refinement?.trim()) {
				planReviewApproved = false;
				planActionPending = false;
				persistState();
				pi.sendUserMessage(refinement.trim());
				return;
			}
			planActionPending = true;
			persistState();
			return;
		}

		planActionPending = false;
		persistState();
	}

	async function handlePlanReviewResult(result: PlannotatorReviewResultEvent, ctx?: ExtensionContext): Promise<void> {
		if (!pendingPlanReviewId || result.reviewId !== pendingPlanReviewId) return;

		pendingPlanReviewId = undefined;
		planReviewPending = false;
		planReviewFeedback = result.feedback?.trim() || undefined;

		if (result.approved) {
			planReviewApproved = true;
			planActionPending = true;
			persistState();
			if (ctx?.hasUI) {
				ctx.ui.notify(`Plan "${planTitle ?? "untitled"}" approved in Plannotator.`, "info");
			}
			if (ctx) {
				await promptPostPlanAction(ctx);
			}
			return;
		}

		planReviewApproved = false;
		planActionPending = false;
		persistState();
		if (ctx?.hasUI) {
			ctx.ui.notify(`Plan "${planTitle ?? "untitled"}" needs refinement in Plannotator.`, "warning");
		}
		if (currentMode === "fuxi") {
			pi.sendUserMessage(buildRefinementMessage());
		}
	}

	async function startPlanReview(ctx: ExtensionContext): Promise<string> {
		if (!planContent || !planTitle) {
			return "Error: No plan found. Call plan_write first.";
		}

		const response = await requestPlannotator<PlannotatorPlanReviewStartResult>("plan-review", {
			planContent,
			origin: "fuxi",
		} satisfies PlannotatorPlanReviewPayload);

		if (response.status === "handled" && response.result.status === "pending") {
			pendingPlanReviewId = response.result.reviewId;
			planReviewPending = true;
			planReviewApproved = false;
			planReviewFeedback = undefined;
			planActionPending = false;
			persistState();
			return `Plan "${planTitle}" finalized and sent to Plannotator for review.`;
		}

		pendingPlanReviewId = undefined;
		planReviewPending = false;
		planReviewApproved = true;
		planReviewFeedback = undefined;
		planActionPending = true;
		persistState();

		const reason = response.status === "handled" ? undefined : response.error;
		if (reason && ctx.hasUI) {
			ctx.ui.notify(`${reason} Falling back to the built-in plan prompt.`, "warning");
		}
		return `Plan "${planTitle}" finalized and ready for review.`;
	}

	async function recoverPlanReview(ctx: ExtensionContext): Promise<void> {
		if (!pendingPlanReviewId) return;

		const response = await requestPlannotator<PlannotatorReviewStatusResult>("review-status", {
			reviewId: pendingPlanReviewId,
		});

		if (response.status === "handled") {
			if (response.result.status === "completed") {
				await handlePlanReviewResult(response.result, ctx);
				return;
			}
			if (response.result.status === "pending") {
				return;
			}
		}

		pendingPlanReviewId = undefined;
		planReviewPending = false;
		planReviewApproved = true;
		planReviewFeedback = undefined;
		planActionPending = true;
		persistState();

		const reason = response.status === "handled" ? "Plannotator review state could not be recovered." : response.error;
		if (reason && ctx.hasUI) {
			ctx.ui.notify(`${reason} Falling back to the built-in plan prompt.`, "warning");
		}
	}

	pi.events.on(PLANNOTATOR_REVIEW_RESULT_CHANNEL, async (data) => {
		const result = data as Partial<PlannotatorReviewResultEvent> | null;
		if (!result || typeof result.reviewId !== "string" || typeof result.approved !== "boolean") return;
		await handlePlanReviewResult({
			reviewId: result.reviewId,
			approved: result.approved,
			feedback: typeof result.feedback === "string" ? result.feedback : undefined,
		}, activeCtx);
	});

	pi.on("session_shutdown", async () => {
		activeCtx = undefined;
	});

	// -----------------------------------------------------------------------
	// Plan tools
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "plan_write",
		label: "PlanWrite",
		description: "Save a plan to the session. Use in Fu Xi (plan) mode to store the plan before calling exit_plan_mode.",
		parameters: Type.Object({
			content: Type.String({ description: "Full plan content in markdown" }),
		}),
		async execute(_toolCallId, params) {
			planContent = params.content;
			planTitle = undefined; // draft until exit_plan_mode
			resetPlanReviewState();
			pi.appendEntry<PlanEntry>("plan", { content: params.content, draft: true });

			return {
				content: [{ type: "text", text: "Plan saved to session. Call exit_plan_mode with a title when ready." }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "ExitPlanMode",
		description:
			"Finalize the plan and signal completion. You MUST call plan_write first. Provide a short title for the plan.",
		parameters: Type.Object({
			title: Type.String({ description: "Short plan title, e.g. AUTH_REFACTOR" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planContent) {
				return {
					content: [{ type: "text", text: "Error: No plan found. Call plan_write first." }],
					details: {},
					isError: true,
				};
			}

			const trimmed = params.title.trim().replace(/\.md$/i, "");
			if (!trimmed || /[/\\]/.test(trimmed)) {
				return {
					content: [{ type: "text", text: "Error: Title must be non-empty without path separators." }],
					details: {},
					isError: true,
				};
			}

			planTitle = trimmed;
			pi.appendEntry<PlanEntry>("plan", { title: trimmed, content: planContent, draft: false });

			const reviewMessage = await startPlanReview(ctx);
			return {
				content: [{ type: "text", text: reviewMessage }],
				details: { title: trimmed, reviewPending: planReviewPending, reviewId: pendingPlanReviewId },
			};
		},
	});

	pi.registerTool({
		name: "plan_read",
		label: "PlanRead",
		description:
			"Read the current plan from the session. Fallback for post-compaction or manual Hou Tu entry. In normal Fu Xi → Hou Tu flow the plan is injected automatically.",
		parameters: Type.Object({}),
		async execute() {
			if (planContent) {
				return {
					content: [
						{
							type: "text",
							text: planTitle ? `# Plan: ${planTitle}\n\n${planContent}` : planContent,
						},
					],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: "No plan found in session." }],
				details: {},
				isError: true,
			};
		},
	});

	// -----------------------------------------------------------------------
	// CLI flag
	// -----------------------------------------------------------------------

	pi.registerFlag("mode", {
		description: "Agent mode: kuafu (build), fuxi (plan), houtu (execute)",
		type: "string",
		default: "kuafu",
	});

	// -----------------------------------------------------------------------
	// Command
	// -----------------------------------------------------------------------

	pi.registerCommand("mode", {
		description: "Switch agent mode (kuafu/fuxi/houtu)",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const filtered = MODES
				.filter((mode) => !query || mode.startsWith(query) || MODE_META[mode].alias.startsWith(query))
				.map((mode) => ({ value: mode, label: MODE_META[mode].label }));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				// Show selector
				const items = MODES.map((m) => {
					const active = m === currentMode ? " (active)" : "";
					return `${colored(m, MODE_META[m].label)}${active}`;
				});
				const choice = await ctx.ui.select("Agent Mode", items);
				if (!choice) return;
				const selected = MODES.find((m) => choice.includes(m));
				if (selected) switchMode(selected, ctx);
				return;
			}

			const name = args.trim().toLowerCase();
			const resolved = MODE_ALIASES[name] ?? (MODES.includes(name as Mode) ? (name as Mode) : null);
			if (!resolved) {
				ctx.ui.notify(`Unknown mode: "${name}". Available: ${MODES.join(", ")}`, "error");
				return;
			}
			switchMode(resolved, ctx);
		},
	});

	// /mode:fuxi, /mode:houtu, /mode:kuafu (+ aliases)
	for (const mode of MODES) {
		pi.registerCommand(`mode:${mode}`, {
			description: `Switch to ${mode} mode`,
			handler: async (args, ctx) => {
				switchMode(mode, ctx);
				const prompt = args?.trim();
				if (prompt) {
					pi.sendUserMessage(prompt);
				}
			},
		});
	}
	for (const [alias, target] of Object.entries(MODE_ALIASES)) {
		pi.registerCommand(`mode:${alias}`, {
			description: `Switch to ${target} mode`,
			handler: async (args, ctx) => {
				switchMode(target, ctx);
				const prompt = args?.trim();
				if (prompt) {
					pi.sendUserMessage(prompt);
				}
			},
		});
	}

	// -----------------------------------------------------------------------
	// Bare word input: typing "fuxi" transforms to /mode:fuxi
	// -----------------------------------------------------------------------

	pi.on("input", async (event) => {
		const trimmed = event.text.trim().toLowerCase();
		const resolved = MODE_ALIASES[trimmed] ?? (MODES.includes(trimmed as Mode) ? (trimmed as Mode) : null);
		if (resolved) {
			return { action: "transform" as const, text: `/mode:${resolved}` };
		}
		return { action: "continue" as const };
	});

	// -----------------------------------------------------------------------
	// Shortcut: Ctrl+Shift+M to cycle
	// -----------------------------------------------------------------------

	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle agent mode",
		handler: async (ctx) => {
			const idx = MODES.indexOf(currentMode);
			const next = MODES[(idx + 1) % MODES.length];
			switchMode(next, ctx);
		},
	});

	// -----------------------------------------------------------------------
	// Block destructive bash in Fu Xi (plan) mode
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event) => {
		if (currentMode !== "fuxi" || event.toolName !== "bash") return;
		const command = (event.input as { command?: string }).command ?? "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not read-only). Use /mode kuafu to switch to build mode first.\nCommand: ${command}`,
			};
		}
	});

	// -----------------------------------------------------------------------
	// Prompt injection via before_agent_start
	// -----------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		const config = loadConfig(currentMode);
		if (!config.body) return;

		// Hou Tu: inject the plan as a message on first turn after switch
		if (currentMode === "houtu" && justSwitchedToHoutu && planContent) {
			justSwitchedToHoutu = false;
			return {
				message: {
					customType: "plan-context",
					content: buildPlanContextContent(),
					display: true,
				},
				systemPrompt: event.systemPrompt + "\n\n" + config.body,
			};
		}

		return {
			systemPrompt: event.systemPrompt + "\n\n" + config.body,
		};
	});

	// -----------------------------------------------------------------------
	// Context: strip stale Fu Xi noise when in Hou Tu mode
	// -----------------------------------------------------------------------

	pi.on("context", async (event) => {
		if (currentMode !== "houtu") return;

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

	// -----------------------------------------------------------------------
	// Post-plan prompt: after Fu Xi finishes, ask what's next
	// -----------------------------------------------------------------------

	pi.on("agent_end", async (_event, ctx) => {
		activeCtx = ctx;
		if (currentMode !== "fuxi" || !ctx.hasUI) return;
		if (planReviewPending) return;
		await promptPostPlanAction(ctx);
	});

	// -----------------------------------------------------------------------
	// Session start: restore state
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		// Check --mode flag
		const flagValue = pi.getFlag("mode");
		if (typeof flagValue === "string" && flagValue && flagValue !== "kuafu") {
			const resolved = MODE_ALIASES[flagValue] ?? (MODES.includes(flagValue as Mode) ? (flagValue as Mode) : null);
			if (resolved) {
				currentMode = resolved;
			}
		}

		// Restore persisted state (unless flag overrode)
		if (!flagValue || flagValue === "kuafu") {
			const entries = ctx.sessionManager.getEntries();
			const modeEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "agent-mode")
				.pop() as { data?: ModeState } | undefined;

			if (modeEntry?.data) {
				currentMode = modeEntry.data.mode ?? currentMode;
				planTitle = modeEntry.data.planTitle;
				planContent = modeEntry.data.planContent;
				pendingPlanReviewId = modeEntry.data.planReviewId;
				planReviewPending = modeEntry.data.planReviewPending ?? false;
				planReviewApproved = modeEntry.data.planReviewApproved ?? false;
				planReviewFeedback = modeEntry.data.planReviewFeedback;
				planActionPending = modeEntry.data.planActionPending ?? false;
			}
		}

		if (!pendingPlanReviewId) {
			planReviewPending = false;
		}

		// Restore plan content from plan entries if not in mode state
		if (!planContent) {
			const entries = ctx.sessionManager.getEntries();
			const planEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan")
				.pop() as { data?: PlanEntry } | undefined;

			if (planEntry?.data?.content) {
				planContent = planEntry.data.content;
				planTitle = planEntry.data.title ?? planTitle;
			}
		}

		applyMode(ctx);
		await recoverPlanReview(ctx);
		await promptPostPlanAction(ctx);
	});
}
