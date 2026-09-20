// Derived from L2ncE/pi-recap at commit 02057d0; modified by Panda Harness. See README.md and LICENSE.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import {
	buildInputKey,
	cleanSingleLine,
	extractText,
	extractToolNames,
	limitWords,
	similarity,
	wrapText,
} from "./content.js";
import { completeRecap, resolveRecapModelCandidates } from "./model.js";
import { getRecapConfig } from "./settings.js";

const STATE_KEY = "pi-recap";
const WIDGET_KEY = "pi-recap";
const RECAP_PREFIX = "※ recap:";
const MAX_ROUNDS = 3;

type SessionState = { recap?: string; goal?: string; inputKey?: string };
type Round = { user: string; assistant: string; tools: string[] };
type GenerateOutcome =
	| { kind: "generated" }
	| { kind: "busy" }
	| { kind: "skipped"; reason: string };

let currentRecap: string | null = null;
let goalPrompt: string | null = null;
let lastInputKey: string | null = null;
let isGenerating = false;
let agentEndCount = 0;
let lastAutoUpdateAt = -Infinity;
let widgetRegistered = false;
let widgetPlacement: "aboveEditor" | "belowEditor" | null = null;
let widgetTui: { requestRender(): void } | null = null;

export default function recapExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const state = getStoredState(ctx);
		currentRecap = state.recap ?? null;
		goalPrompt = state.goal ?? null;
		lastInputKey = state.inputKey ?? null;
		agentEndCount = 0;
		lastAutoUpdateAt = -Infinity;
		widgetRegistered = false;
		widgetPlacement = null;
		widgetTui = null;
		renderWidget(ctx);
	});

	pi.on("message_end", async (event, _ctx) => {
		const message = getMessage(event);
		if (!message || message.role !== "user" || goalPrompt) return;
		const text = extractText(message.content).trim();
		if (!text) return;
		goalPrompt = text;
		persistState(pi, { recap: currentRecap ?? undefined, goal: text, inputKey: lastInputKey ?? undefined });
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentEndCount++;
		await generateRecap(pi, ctx, false);
	});

	pi.registerCommand("recap", {
		description: "Generate a session recap now",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.notify("Generating recap…", "info");
			const outcome = await generateRecap(pi, ctx, true);
			if (outcome.kind === "generated") ctx.ui.notify("Recap updated", "info");
			else if (outcome.kind === "busy") ctx.ui.notify("A recap is already being generated", "warning");
			else ctx.ui.notify(`Recap skipped: ${outcome.reason}`, "warning");
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: getRecapConfig(ctx.cwd).placement });
		widgetRegistered = false;
		widgetPlacement = null;
		widgetTui = null;
	});
}

async function generateRecap(pi: ExtensionAPI, ctx: ExtensionContext, force: boolean): Promise<GenerateOutcome> {
	if (isGenerating) return { kind: "busy" };
	if (!ctx.hasUI) return { kind: "skipped", reason: "no UI" };
	const { goal, rounds, userCount } = buildSessionContext(ctx);
	if (!goal || rounds.length === 0) return { kind: "skipped", reason: "no conversation yet" };
	const config = getRecapConfig(ctx.cwd);
	if (!force && userCount < config.minTurns) return { kind: "skipped", reason: `fewer than ${config.minTurns} turns` };
	const inputKey = buildInputKey(goal, rounds);
	if (!force && inputKey === lastInputKey) return { kind: "skipped", reason: "input unchanged" };
	if (!force && agentEndCount - lastAutoUpdateAt < config.cooldownTurns) return { kind: "skipped", reason: "cooldown" };
	const candidates = resolveRecapModelCandidates(ctx);
	if (candidates.length === 0) return { kind: "skipped", reason: "no usable model" };
	if (!force) lastAutoUpdateAt = agentEndCount;

	isGenerating = true;
	try {
		const effectiveGoal = goalPrompt ?? goal;
		const request: Context = {
			systemPrompt: config.prompt,
			messages: [{ role: "user", content: [{ type: "text", text: buildPrompt(effectiveGoal, rounds) }], timestamp: Date.now() }],
		};
		const result = await completeRecap(
			(candidate, completionRequest) => ctx.modelRegistry.complete(candidate.model, completionRequest, { maxTokens: 512, reasoningEffort: candidate.thinkingLevel ?? "minimal", cacheRetention: "none", signal: ctx.signal }),
			candidates,
			request,
			ctx.signal,
		);
		if (result.kind === "skipped") return result;
		const recap = cleanSingleLine(extractText(result.response.content));
		if (!recap) return { kind: "skipped", reason: "empty model output" };
		if (currentRecap && !force && similarity(currentRecap, recap) >= config.similarityThreshold) {
			lastInputKey = inputKey;
			persistState(pi, { recap: currentRecap, goal: effectiveGoal, inputKey });
			return { kind: "skipped", reason: "similar to displayed recap" };
		}
		currentRecap = limitWords(recap, config.maxWords);
		lastInputKey = inputKey;
		renderWidget(ctx, config.placement);
		persistState(pi, { recap: currentRecap, goal: effectiveGoal, inputKey });
		return { kind: "generated" };
	} finally {
		isGenerating = false;
	}
}

function buildSessionContext(ctx: ExtensionContext): { goal: string | null; rounds: Round[]; userCount: number } {
	const rounds: Round[] = [];
	let current: Round | undefined;
	let userCount = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role === "user") {
			const text = extractText(message.content).trim();
			if (!text) continue;
			userCount++;
			current = { user: text, assistant: "", tools: [] };
			rounds.push(current);
		} else if (message.role === "assistant" && current) {
			current.assistant = extractText(message.content).trim();
			current.tools = extractToolNames(message.content);
		}
	}
	return { goal: rounds[0]?.user ?? null, rounds: rounds.slice(-MAX_ROUNDS), userCount };
}

function buildPrompt(goal: string, rounds: Round[]): string {
	const lines = [
		"<session_goal>",
		"Note: this is the ORIGINAL goal from the start of the session. It may already be completed or superseded. Judge the CURRENT state from <recent_activity> below, not from this goal.",
		goal.slice(0, 200),
		"</session_goal>",
		"",
		"<recent_activity>",
	];
	for (const [index, round] of rounds.entries()) {
		const label = `Round ${index + 1}`;
		lines.push(`${label} user: ${round.user.slice(0, 200)}`);
		if (round.tools.length > 0) lines.push(`${label} tools: ${round.tools.join(", ")}`);
		if (round.assistant) lines.push(`${label} assistant: ${round.assistant.slice(0, 300)}`);
	}
	return [...lines, "</recent_activity>", "", "Write the recap now.", "Write the recap in the same language as the user's messages."].join("\n");
}

function renderWidget(ctx: ExtensionContext, placement = getRecapConfig(ctx.cwd).placement): void {
	if (!ctx.hasUI) return;
	if (widgetRegistered && widgetPlacement === placement) {
		widgetTui?.requestRender();
		return;
	}
	if (widgetRegistered && widgetPlacement) ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: widgetPlacement });
	ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
		widgetTui = tui;
		return {
			dispose() {},
			invalidate() {},
			render(width: number): string[] {
				if (!currentRecap) return [];
				return wrapText(`${RECAP_PREFIX} ${currentRecap}`, Math.max(12, width - 1)).map((line, index) => {
					if (index > 0) return theme.fg("muted", theme.italic(line));
					const prefixLength = RECAP_PREFIX.length;
					return theme.fg("dim", line.slice(0, 2)) + theme.fg("accent", theme.bold(line.slice(2, prefixLength))) + theme.fg("muted", theme.italic(line.slice(prefixLength)));
				});
			},
		};
	}, { placement });
	widgetRegistered = true;
	widgetPlacement = placement;
}

function getStoredState(ctx: ExtensionContext): SessionState {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== STATE_KEY || !isRecord(entry.data)) continue;
		return {
			recap: typeof entry.data.recap === "string" ? entry.data.recap : undefined,
			goal: typeof entry.data.goal === "string" ? entry.data.goal : undefined,
			inputKey: typeof entry.data.inputKey === "string" ? entry.data.inputKey : undefined,
		};
	}
	return {};
}

function getMessage(event: unknown): Record<string, unknown> | undefined {
	return isRecord(event) && isRecord(event.message) ? event.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistState(pi: ExtensionAPI, state: SessionState): void {
	pi.appendEntry(STATE_KEY, state);
}
