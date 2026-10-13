/**
 * ask — Structured user decisions, notes and clarification in Pi's TUI.
 *
 * Sources: badlogic/pi-mono (questionnaire.ts, question.ts), can1357/oh-my-pi
 * (ask lineage), and eko24ive/pi-ask (notes, previews and clarification).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { isTui } from "../lib/mode.js";
import { extractToolText, renderToolCall, renderToolExpanded, renderToolSummary } from "../lib/tool-output.js";
import { createAskDialog, type AskDialogResult } from "./dialog.js";
import { formatAnswerLine, formatInvalidPayload, formatNonTuiQuestions, formatResultText } from "./format.js";
import { buildInvalidDetails, normalizeQuestions, validateInput } from "./normalize.js";
import { AskParams, type AskDetails, type IncomingQuestion } from "./types.js";

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: "Ask the user structured questions with single/multi-select choices, free text, notes and previews.",
		promptSnippet: "Ask the user structured questions (single/multi-select, free text, notes, previews) when a decision depends on their preference",
		promptGuidelines: [
			"Use ask instead of guessing when the next step depends on a user preference or a choice between valid directions.",
			"Bundle 1-3 related decisions per ask call; ask one at a time only when a question depends on an earlier answer.",
			"In ask, use one decision per question, short labels, distinct options without filler; set recommended to the grounded default and explain why in that option's description.",
			"Use ask option preview when the user must compare code, diffs, or layouts.",
			"On an ask elaborate result, answer the user's notes first, then call ask again only for unresolved questions.",
		],
		parameters: AskParams,
		// Parallel batches share one editor slot: a second blocking dialog would displace
		// this one, and pi never resolves the displaced custom() promise.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params.questions;
			const validation = validateInput(input);
			if (validation.ok === false) return {
				content: [{ type: "text", text: formatInvalidPayload(validation.issues) }],
				details: buildInvalidDetails(input, params.title, validation.issues),
			};
			const questions = normalizeQuestions(input);
			const emptyDetails: AskDetails = { title: params.title, questions: input, answers: [], notes: [], cancelled: true, mode: "submit" };
			if (!isTui(ctx)) return { content: [{ type: "text", text: formatNonTuiQuestions(questions) }], details: emptyDetails };
			if (signal?.aborted) return { content: [{ type: "text", text: formatResultText(questions, emptyDetails, true) }], details: emptyDetails };

			pi.events.emit("user-prompted", { tool: "ask" });
			// Herdr's agent-state integration counts blockers on this channel; the .finally()
			// below emits the mandatory balancing `active:false`.
			pi.events.emit("herdr:blocked", { active: true, label: "Ask" });

			// ponytail: ctx.ui.custom() does not report OSC 7501 "blocked" program status
			// (pi-side gap; built-in dialogs set it inside interactive-mode). Delete the
			// setProgramStatus pair when pi wires it into showExtensionCustom. The restore in
			// .finally() is mandatory: pi's reporter dedupes on its own last report and would
			// never re-emit "working". Ceiling: hardcodes app "pi".
			let dialogTui: TUI | undefined;
			const outcome = await ctx.ui.custom<AskDialogResult>((tui, theme, kb, done) => {
				dialogTui = tui;
				tui.terminal.setProgramStatus({ state: "blocked", kind: "question", message: "Ask", app: "pi" });
				return createAskDialog({ questions, input, title: params.title, tui, theme, keybindings: kb, signal, done });
			}).finally(() => {
				dialogTui?.terminal.setProgramStatus({ state: "working", message: pi.getSessionName(), app: "pi" });
				pi.events.emit("herdr:blocked", { active: false });
			});
			return { content: [{ type: "text", text: formatResultText(questions, outcome.details, outcome.aborted) }], details: outcome.details };
		},
		renderCall(args, theme, _context) {
			const qs: IncomingQuestion[] = Array.isArray(args.questions) ? args.questions : [];
			const flags: string[] = [];
			if (qs.some((q) => q?.multi === true)) flags.push("multi");
			if (qs.some((q) => typeof q?.recommended === "number")) flags.push("recommended");
			if (qs.some((q) => q?.allowOther !== false)) flags.push("other");
			if (qs.some((q) => q?.options?.some((o) => o.preview !== undefined))) flags.push("preview");
			if (qs.some((q) => q?.required === true)) flags.push("required");
			const firstPrompt = qs.find((q) => typeof q?.prompt === "string" && q.prompt.length > 0)?.prompt;
			const parts = [`${qs.length} question${qs.length !== 1 ? "s" : ""}`];
			if (args.title !== undefined) parts.unshift(args.title);
			if (flags.length > 0) parts.push(flags.join(", "));
			if (firstPrompt) parts.push(`first: ${firstPrompt}`);
			return renderToolCall("ask", parts.join(" · "), theme);
		},
		renderResult(result, options, theme, _context) {
			const raw = extractToolText(result);
			if (options.expanded) return renderToolExpanded(raw);
			const d = result.details as AskDetails | undefined;
			const summary = (lines: string[], expandLabel = "full result") => renderToolSummary(lines, theme, { expandable: raw.length > 0, expandLabel });
			if (!d) return summary([raw ? `result: ${raw}` : "result: no answer details"]);
			if (d.error) return summary([`status: invalid payload · ${d.error.issues.length} issues`]);
			if (d.mode === "elaborate") return summary([`status: elaborate · ${d.notes.length} notes`]);
			if (d.cancelled) return summary(["status: cancelled", "answer: user cancelled"]);
			if (!d.answers?.length) {
				const count = Array.isArray(d.questions) ? d.questions.length : 0;
				return summary([`status: no answer · ${count} question${count !== 1 ? "s" : ""}`]);
			}
			const first = d.answers[0];
			const q = normalizeQuestions(d.questions).find((q) => q.id === first.id);
			const answer = q ? formatAnswerLine(q, first).replace(`${q.rawLabel}: `, `${q.rawLabel} · `).replace("user selected: ", "").replace("user wrote: ", "wrote: ") : first.id;
			return summary([`status: answered · ${d.answers.length}/${d.questions.length}`, `answer: ${answer}`], "all answers");
		},
	});
}
