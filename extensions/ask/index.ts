/**
 * ask — Structured user decisions, notes and clarification in Pi's TUI.
 *
 * Sources: badlogic/pi-mono (questionnaire.ts, question.ts), can1357/oh-my-pi
 * (ask lineage), and eko24ive/pi-ask (notes, previews and clarification).
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTui } from "../lib/mode.js";
import { extractToolText, renderToolCall, renderToolExpanded, renderToolSummary } from "../lib/tool-output.js";
import { createAskAutocompleteProvider } from "./autocomplete.js";
import { createAskDialog, type AskDialogResult } from "./dialog.js";
import { formatInvalidPayload, formatNonTuiQuestions, formatResultText, humanAnswer, humanNote } from "./format.js";
import { buildInvalidDetails, normalizeQuestions, validateInput } from "./normalize.js";
import { AskParams, type Answer, type AskDetails, type AskIssue, type AskNote, type IncomingQuestion } from "./types.js";

/** Pi's tool row width in an 80-column terminal (its Box pads one column per side). */
const CALL_HEADER_WIDTH = 78;

type LabeledText = { label: string; text: string };
type AskView = {
	details: AskDetails;
	rows: (LabeledText & { answered: boolean; required: boolean })[];
	notes: LabeledText[];
	answered: number;
	missing: number;
};

const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ");
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Presentation facts from saved details. Undefined when missing or malformed; older results lack notes, mode and indices. */
function readView(value: unknown): AskView | undefined {
	if (!value || typeof value !== "object") return undefined;
	const d = value as Partial<AskDetails>;
	if (d.error !== undefined && !Array.isArray(d.error?.issues)) return undefined;
	if (!d.error && (typeof d.cancelled !== "boolean" || !Array.isArray(d.answers))) return undefined;
	const questions: Partial<IncomingQuestion>[] = Array.isArray(d.questions) ? d.questions.filter((q) => q && typeof q === "object") : [];
	const answers: Answer[] = Array.isArray(d.answers) ? d.answers.filter((a) => a && typeof a === "object" && typeof a.id === "string" && (a.labels === undefined || Array.isArray(a.labels))) : [];
	const notes: AskNote[] = Array.isArray(d.notes) ? d.notes.filter((n) => n && typeof n === "object" && typeof n.text === "string") : [];
	const details: AskDetails = { ...d, questions: questions as IncomingQuestion[], answers, notes, cancelled: d.cancelled === true, mode: d.mode === "elaborate" ? "elaborate" : "submit" };
	const labelOf = (q: Partial<IncomingQuestion>, i: number) => oneLine(typeof q.label === "string" && q.label.length > 0 ? q.label : `Q${i + 1}`);
	const rows = questions.map((q, i) => {
		const text = humanAnswer(answers.find((a) => a.id === q.id));
		return { label: labelOf(q, i), text: oneLine(text ?? ""), answered: text !== undefined, required: q.required === true };
	});
	for (const a of answers) {
		const text = questions.some((q) => q.id === a.id) ? undefined : humanAnswer(a);
		if (text !== undefined) rows.push({ label: oneLine(a.id), text: oneLine(text), answered: true, required: false });
	}
	const noteViews = notes.map((n) => {
		const i = questions.findIndex((q) => q.id === n.questionId);
		const q = questions[i];
		return {
			label: q ? labelOf(q, i) : oneLine(String(n.questionId)),
			text: oneLine(humanNote({ options: Array.isArray(q?.options) ? q.options : [] }, n)),
		};
	});
	const answered = rows.filter((r) => r.answered).length;
	return { details, rows, notes: noteViews, answered, missing: rows.filter((r) => r.required && !r.answered).length };
}

/** State-transition row shared by the collapsed and expanded views; each segment carries its own colour. */
function statusLine(view: AskView, theme: Theme): string {
	const { details: d, notes, answered, missing, rows } = view;
	const m = (text: string) => theme.fg("muted", text);
	const progress = `${answered}/${rows.length}`;
	const missingSuffix = missing > 0 ? m(" · ") + theme.fg("warning", `${missing} required missing`) : "";
	if (d.aborted) return `${theme.fg("warning", "✗")}${m(" aborted before the user answered")}`;
	if (d.cancelled) return `${theme.fg("warning", "✗")}${m(" cancelled by user")}`;
	if (d.mode === "elaborate") return `${theme.fg("text", "✎")}${m(` elaborate${notes.length ? ` · ${plural(notes.length, "note")}` : ""} · ${progress} answered`)}`;
	if (answered === 0) return `${theme.fg("success", "✓")}${m(` submitted · ${progress} answered`)}${missingSuffix}`;
	return `${theme.fg("success", "✓")}${m(` answered ${progress}`)}${missingSuffix}`;
}

function noteText(text: string, theme: Theme): string {
	return theme.fg("muted", theme.italic(text));
}

function issueLine(issue: AskIssue, theme: Theme): string {
	return `${theme.fg("muted", `${oneLine(issue.path)}: `)}${theme.fg("text", oneLine(issue.message))}`;
}

/** Collapsed decision view: status, then answers or the first note, then the expand hint when expansion adds detail. */
function renderCollapsed(view: AskView, theme: Theme) {
	const { details: d, rows, notes } = view;
	const issues = d.error?.issues;
	if (issues) {
		const status = `${theme.fg("error", "✗")}${theme.fg("muted", ` invalid payload · ${plural(issues.length, "issue")}`)}`;
		return renderToolSummary(issues.length ? [status, issueLine(issues[0], theme)] : [status], theme, { expandable: issues.length > 0, expandLabel: "all issues" });
	}
	const status = statusLine(view, theme);
	if (d.cancelled) return renderToolSummary([status], theme);
	const expandLabel = notes.length ? "answers and notes" : "all answers";
	const firstNote = notes[0] ? `${theme.fg("muted", `${notes[0].label} `)}${noteText(`✎ ${notes[0].text}`, theme)}` : undefined;
	if (d.mode === "elaborate") return renderToolSummary(firstNote ? [status, firstNote] : [status], theme, { expandable: true, expandLabel });
	if (view.answered === 0) return renderToolSummary([status], theme, { expandable: notes.length > 0, expandLabel });
	const answers = rows.filter((r) => r.answered).map((r) => `${theme.fg("muted", `${r.label} `)}${theme.fg("text", r.text)}`);
	return renderToolSummary([status, answers.join(theme.fg("muted", " · "))], theme, { expandable: true, expandLabel });
}

/** Wrap styled text to width; truncate any part an indivisible grapheme still overflows. */
function wrapToWidth(text: string, width: number): string[] {
	return width <= 0 ? [] : wrapTextWithAnsi(text, width).map((line) => truncateToWidth(line, width, ""));
}

/** Aligned `Label  value` rows when the value column keeps room; stacked label over indented value otherwise. */
function pairLines(entries: { label: string; value: string }[], labelCol: number, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	for (const { label, value } of entries) {
		if (width - labelCol >= Math.max(labelCol, 20)) {
			const [first = "", ...rest] = wrapToWidth(value, width - labelCol);
			lines.push(theme.fg("muted", label) + " ".repeat(labelCol - visibleWidth(label)) + first, ...rest.map((line) => " ".repeat(labelCol) + line));
		} else {
			const indent = width > 4 ? "  " : "";
			lines.push(...wrapToWidth(theme.fg("muted", label), width), ...wrapToWidth(value, width - indent.length).map((line) => indent + line));
		}
	}
	return lines;
}

/** Expanded report: status, every question's answer, then notes. The call header already names the ask. */
function renderReport(view: AskView, theme: Theme): Component {
	const { details: d, rows, notes } = view;
	const build = (width: number): string[] => {
		const lines = wrapToWidth(statusLine(view, theme), width);
		if (d.cancelled) return lines;
		// One label column for answers and notes keeps both sections aligned.
		const labelCol = Math.max(0, ...[...rows, ...notes].map((e) => visibleWidth(e.label))) + 2;
		const answers = rows.map((r) => ({
			label: r.label,
			value: r.answered ? theme.fg("text", r.text) : r.required ? theme.fg("warning", "! no answer · required") : theme.fg("muted", "— no answer"),
		}));
		if (answers.length) lines.push("", ...pairLines(answers, labelCol, width, theme));
		if (notes.length) {
			lines.push("", ...wrapToWidth(theme.fg("text", theme.bold("Notes")), width));
			lines.push(...pairLines(notes.map((n) => ({ label: n.label, value: noteText(n.text, theme) })), labelCol, width, theme));
		}
		return lines;
	};
	return {
		render: (width) => {
			const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
			return safeWidth === 0 ? [] : build(safeWidth);
		},
		invalidate() {},
	};
}

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
			if (signal?.aborted) return { content: [{ type: "text", text: formatResultText(questions, emptyDetails, true) }], details: { ...emptyDetails, aborted: true } };

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
				return createAskDialog({ questions, input, title: params.title, tui, theme, keybindings: kb, autocompleteProvider: createAskAutocompleteProvider(ctx.cwd, pi.getCommands()), signal, done });
			}).finally(() => {
				dialogTui?.terminal.setProgramStatus({ state: "working", message: pi.getSessionName(), app: "pi" });
				pi.events.emit("herdr:blocked", { active: false });
			});
			const details: AskDetails = outcome.aborted ? { ...outcome.details, aborted: true } : outcome.details;
			return { content: [{ type: "text", text: formatResultText(questions, outcome.details, outcome.aborted) }], details };
		},
		renderCall(args, theme, _context) {
			const qs: IncomingQuestion[] = Array.isArray(args.questions) ? args.questions : [];
			const count = plural(qs.length, "question");
			const title = typeof args.title === "string" && args.title.trim() ? args.title : undefined;
			const subject = title ?? qs.find((q) => typeof q?.prompt === "string" && q.prompt.trim())?.prompt;
			if (!subject) return renderToolCall("ask", count, theme);
			// One row at 80 columns: `▸ ask · ` + subject + ` · N questions`.
			const room = CALL_HEADER_WIDTH - visibleWidth(`▸ ask ·  · ${count}`);
			// truncateToWidth ends with a full reset, so the count re-applies renderToolCall's target colour.
			return renderToolCall("ask", `${truncateToWidth(oneLine(subject.trim()), room, "…")}${theme.fg("accent", ` · ${count}`)}`, theme);
		},
		renderResult(result, options, theme, _context) {
			const raw = extractToolText(result);
			const view = readView(result.details);
			if (!view) {
				if (options.expanded) return renderToolExpanded(raw);
				return renderToolSummary([raw ? `result: ${raw}` : "result: no answer details"], theme, { expandable: raw.length > 0, expandLabel: "full result" });
			}
			if (!options.expanded) return renderCollapsed(view, theme);
			return view.details.error ? renderToolExpanded(raw) : renderReport(view, theme);
		},
	});
}
