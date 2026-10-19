/**
 * ask — Interactive component: state effects, editors, previews and rendering.
 *
 * Owns the abort listener for one interaction; completion and disposal remove it.
 * The pure AskState owns all decision semantics.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, Editor, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { humanAnswer, humanNote } from "./format.js";
import { createAskKeys, type AskKeybindings } from "./keys.js";
import { AskState, type AskEffect, REVIEW_ACTIONS } from "./state.js";
import type { AskDetails, IncomingQuestion, NormalizedQuestion } from "./types.js";

export interface AskDialogResult {
	details: AskDetails;
	aborted: boolean;
}

export interface AskDialogOptions {
	questions: NormalizedQuestion[];
	input: IncomingQuestion[];
	title?: string;
	tui: TUI;
	theme: Pick<Theme, "fg" | "bg" | "bold" | "italic">;
	keybindings?: AskKeybindings;
	autocompleteProvider?: AutocompleteProvider;
	signal?: AbortSignal;
	done(result: AskDialogResult): void;
}

/** Preview rows per question, including the overflow line. */
const PREVIEW_CAP = 12;
/** Inner width at which the preview moves beside the options. */
const WIDE_PREVIEW_WIDTH = 96;
/** Ultra-wide terminals keep a readable content area; only the two rules span the full width. */
const MAX_WIDTH = 140;
const ACTION_NAMES = { submit: "Submit", elaborate: "Elaborate", cancel: "Cancel" } as const;

export function createAskDialog({ questions, input, title, tui, theme, keybindings, autocompleteProvider, signal, done }: AskDialogOptions) {
	const state = new AskState(questions);
	const keys = createAskKeys(keybindings);
	const editor = new Editor(tui, {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			description: (text) => theme.fg("muted", text),
			noMatch: (text) => theme.fg("warning", text),
			scrollInfo: (text) => theme.fg("dim", text),
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
		},
	});
	if (autocompleteProvider) editor.setAutocompleteProvider(autocompleteProvider);
	let finished = false;
	function dispose() {
		finished = true;
		signal?.removeEventListener("abort", onAbort);
		editor.focused = false;
		editor.setText("");
	}
	function apply(effect: AskEffect | undefined, aborted = false) {
		if (!effect || finished) return;
		if (effect.kind === "openEditor") editor.setText(effect.initialText);
		else {
			dispose();
			done({ details: state.buildDetails(input, title, effect.result), aborted });
		}
	}
	function onAbort() {
		apply(state.finalize({ cancelled: true }), true);
	}
	function refresh() {
		editor.invalidate();
		if (!finished) tui.requestRender();
	}
	editor.onSubmit = (text) => {
		apply(state.submitEditor(text));
		refresh();
	};
	function handleInput(data: string) {
		if (finished) return;
		const key = keys.resolve(data);
		if (state.editorTarget) {
			if (key?.kind === "cancel" && !editor.isShowingAutocomplete()) {
				state.cancelEditor(editor.getExpandedText());
				editor.setText("");
			} else editor.handleInput(data);
		} else apply(state.dispatch(key));
		refresh();
	}

	const muted = (s: string) => theme.fg("muted", s);
	const plain = (s: string) => theme.fg("text", s);
	const border = (s: string) => theme.fg("borderMuted", s);
	const noteStyle = (s: string) => muted(theme.italic(s));
	const cursorMark = (on: boolean) => on ? theme.fg("accent", "› ") : "  ";
	function pad(line: string, width: number): string {
		const cell = truncateToWidth(line, Math.max(0, width));
		return cell + " ".repeat(Math.max(0, width - visibleWidth(cell)));
	}
	/** Wrap plain text, style each line, and indent every line by `indent` columns. */
	function wrap(text: string, width: number, style: (s: string) => string, indent = 0): string[] {
		return wrapTextWithAnsi(text, Math.max(1, width - indent)).map((line) => `${" ".repeat(indent)}${style(line)}`);
	}
	function editLines(width: number, indent: number): string[] {
		return editor.render(Math.max(1, width - indent)).map((line) => `${" ".repeat(indent)}${line}`);
	}
	function editingNote(qId: string, optionIndex?: number): boolean {
		const target = state.editorTarget;
		return target?.kind === "note" && target.questionId === qId && target.optionIndex === optionIndex;
	}
	function noteLines(qId: string, width: number, indent: number, optionIndex?: number): string[] {
		if (editingNote(qId, optionIndex)) return [`${" ".repeat(indent)}${theme.fg("accent", "✎")}`, ...editLines(width, indent + 2)];
		const note = state.getNote(qId, optionIndex);
		return note ? wrap(`✎ ${note}`, width, noteStyle, indent) : [];
	}

	function optionLines(q: NormalizedQuestion, width: number): string[] {
		const numWidth = String(q.options.length).length + 2;
		const labelCol = 2 + (q.multi ? 2 : 0) + numWidth;
		const box = (on: boolean) => q.multi ? (on ? plain("☑ ") : muted("☐ ")) : "";
		const lines: string[] = [];
		q.options.forEach((option, i) => {
			const cursor = i === state.optionIndex;
			const tag = q.recommended === i ? `  ${theme.fg("success", theme.bold("[Recommended]"))}` : "";
			lines.push(`${cursorMark(cursor)}${box(state.isOptionToggled(q.id, i))}${theme.fg(cursor ? "text" : "muted", String(i + 1).padEnd(numWidth))}${theme.fg(cursor ? "accent" : "text", option.label)}${tag}`);
			if (option.description) lines.push(...wrap(option.description, width, muted, labelCol));
			lines.push(...noteLines(q.id, width, labelCol, i));
		});
		if (q.allowOther) {
			const cursor = state.isOtherRow(q, state.optionIndex);
			const custom = state.getCustomInput(q.id);
			const draft = state.getDraft({ kind: "custom", questionId: q.id });
			const word = (s: string) => theme.fg(cursor ? "accent" : "muted", s);
			const lead = `${cursorMark(cursor)}${box(custom !== undefined)}${" ".repeat(numWidth)}`;
			const target = state.editorTarget;
			const editing = target?.kind === "custom" && target.questionId === q.id;
			const value = editing ? word("Other")
				: custom !== undefined ? `${word("Other")}  ${plain(`“${custom}”`)}`
					: draft !== undefined ? `${word("Other")}  ${muted(`draft “${draft}”`)}` : word("Other…");
			lines.push(...`${lead}${value}`.split("\n").map((line, i) => i ? `${" ".repeat(labelCol)}${line}` : line));
			if (editing) lines.push(...editLines(width, labelCol));
		}
		return lines;
	}
	/** Exactly H rows for every cursor position, so moving the cursor never changes the dialog height. */
	function previewRows(q: NormalizedQuestion, width: number): string[] {
		const w = Math.max(1, width);
		const height = Math.min(PREVIEW_CAP, Math.max(...q.options.map((o) => o.preview === undefined ? 1 : wrapTextWithAnsi(o.preview, w).length)));
		const preview = q.options[state.optionIndex]?.preview;
		const all = preview === undefined ? [] : wrapTextWithAnsi(preview, w);
		const rows = preview === undefined ? [muted("no preview")]
			: all.length > height ? [...all.slice(0, height - 1).map(plain), muted(`… +${all.length - height + 1} more lines`)]
				: all.map(plain);
		return [...rows, ...Array<string>(Math.max(0, height - rows.length)).fill("")];
	}
	function questionLines(q: NormalizedQuestion, width: number): string[] {
		const lines = [...wrap(q.prompt, width, (s) => plain(theme.bold(s))), ...noteLines(q.id, width, 0), ""];
		if (!q.options.some((o) => o.preview !== undefined)) return [...lines, ...optionLines(q, width)];
		const heading = `Preview · ${q.options[state.optionIndex]?.label ?? "Other"}`;
		if (width >= WIDE_PREVIEW_WIDTH) {
			const leftWidth = Math.floor((width - 3) * 0.45);
			const left = optionLines(q, leftWidth);
			const right = [muted(heading), ...previewRows(q, width - leftWidth - 3)];
			for (let i = 0; i < Math.max(left.length, right.length); i++) lines.push(`${pad(left[i] ?? "", leftWidth)} ${border("│")} ${right[i] ?? ""}`);
			return lines;
		}
		const label = truncateToWidth(heading, Math.max(0, width - 5));
		lines.push(...optionLines(q, width), "", `${border("── ")}${muted(label)} ${border("─".repeat(Math.max(0, width - 4 - visibleWidth(label))))}`);
		return [...lines, ...previewRows(q, width - 2).map((row) => `  ${row}`)];
	}
	function reviewLines(width: number): string[] {
		const labelWidth = Math.min(Math.max(...questions.map((q) => visibleWidth(q.rawLabel))) + 3, Math.floor(width / 2));
		const lines: string[] = [];
		for (const q of questions) {
			const answer = humanAnswer(state.buildAnswer(q));
			const [first = "", ...rest] = answer !== undefined ? wrap(answer, width - labelWidth, plain)
				: [q.required ? theme.fg("warning", "! no answer · required") : muted("— no answer")];
			lines.push(`${pad(muted(q.rawLabel), labelWidth - 2)}  ${first}`, ...rest.map((line) => `${" ".repeat(labelWidth)}${line}`));
			for (const note of state.getNotes().filter((n) => n.questionId === q.id)) lines.push(...wrap(`✎ ${humanNote(q, note)}`, width, noteStyle, labelWidth));
		}
		lines.push("");
		const missing = questions.filter((q) => q.required && !state.isAnswered(q)).length;
		REVIEW_ACTIONS.forEach((action, i) => {
			const cursor = i === state.reviewActionIndex;
			const disabled = action === "elaborate" && !state.elaborateEnabled;
			const suffix = action === "submit" && missing ? theme.fg("warning", `  · ${missing} required unanswered`)
				: disabled ? muted("  add a note first (n/N)") : "";
			lines.push(`${cursorMark(cursor)}${theme.fg(cursor ? "text" : "muted", `${i + 1}  `)}${theme.fg(disabled ? "muted" : cursor ? "accent" : "text", ACTION_NAMES[action])}${suffix}`);
		});
		return lines;
	}
	function tabRow(): string {
		const cells = questions.map((q, i) => {
			const answered = state.isAnswered(q);
			const active = i === state.currentTab;
			const label = active ? theme.fg("accent", theme.bold(q.tabLabel)) : theme.fg(answered ? "text" : "muted", q.tabLabel);
			const cell = ` ${answered ? theme.fg("success", "■") : muted("□")} ${label}${q.required && !answered ? theme.fg("warning", "*") : ""} `;
			return active ? theme.bg("selectedBg", cell) : cell;
		});
		const reviewActive = state.currentTab === questions.length;
		const review = reviewActive ? theme.bg("selectedBg", ` ${theme.fg("accent", theme.bold("Review"))} `) : ` ${muted("Review")} `;
		return `${cells.join(" ")}    ${review}`;
	}
	/** `<key> <word>` segments; drops the lowest-priority segments to fit while always keeping the cancel segment last. */
	function hints(max: number): string {
		const cancel = keys.label("tui.select.cancel");
		if (state.dismissPending) return theme.fg("warning", `${cancel} again discards your answers · any other key keeps them`);
		const seg = (key: string, word: string) => `${plain(key)} ${muted(word)}`;
		const sep = border(" · ");
		function fitHints(segments: string[], last: string): string {
			const kept = [...segments];
			while (kept.length && visibleWidth([...kept, last].join(sep)) > max) kept.pop();
			return [...kept, last].join(sep);
		}
		if (state.editorTarget) return fitHints([seg(keys.label("tui.input.submit"), "save")], seg(cancel, "keep draft"));
		const up = keys.label("tui.select.up");
		const down = keys.label("tui.select.down");
		const move = seg(up === "↑" && down === "↓" ? "↑↓" : `${up}/${down}`, "move");
		const confirm = keys.label("tui.select.confirm");
		const esc = seg(cancel, "cancel");
		const q = state.getCurrentQuestion();
		if (!q) return fitHints([move, seg(`1–${REVIEW_ACTIONS.length}`, "action"), seg(confirm, "run"), seg("Tab", "back")], esc);
		const count = Math.min(9, q.options.length);
		const digits = count > 1 ? `1–${count}` : "1";
		const enter = state.isOtherRow(q, state.optionIndex) ? "type" : q.multi ? "next"
			: state.quickPick ? state.elaborateEnabled ? "review" : "submit" : "pick";
		return fitHints([
			move, q.multi ? seg(`${digits}/Space`, "toggle") : seg(digits, "pick"), seg(confirm, enter), seg("n/N", "note"),
			...(state.quickPick ? [] : [seg("Tab", "next")]),
		], esc);
	}
	/** Title left, progress right-aligned; progress drops before the title truncates. */
	function header(width: number): string {
		const name = title === undefined ? muted("ask") : plain(theme.bold(title.replace(/\s+/g, " ")));
		const progress = muted(`${questions.filter((q) => state.isAnswered(q)).length}/${questions.length} answered`);
		const gap = width - visibleWidth(name) - visibleWidth(progress);
		return questions.length > 1 && gap >= 2 ? `${name}${" ".repeat(gap)}${progress}` : truncateToWidth(name, width);
	}
	function render(width: number): string[] {
		width = Math.max(0, Math.floor(width));
		const area = Math.min(MAX_WIDTH, width);
		const inner = Math.max(0, area - 2);
		// 1-column left indent and right margin inside the content area.
		const row = (line: string) => line ? truncateToWidth(` ${line}`, Math.max(0, area - 1)) : "";
		const rule = border("─".repeat(width));
		const q = state.getCurrentQuestion();
		const lines = [rule];
		if (title !== undefined || questions.length > 1) lines.push(row(header(inner)), "");
		// Tab cells carry their own padding, so the row starts in the gutter and glyphs share the body's left edge.
		if (state.hasTabBar) lines.push(truncateToWidth(tabRow(), Math.max(0, area - 1)), "");
		return [...lines, ...(q ? questionLines(q, inner) : reviewLines(inner)).map(row), "", row(hints(inner)), rule];
	}
	signal?.addEventListener("abort", onAbort);
	if (signal?.aborted) onAbort();
	return {
		render,
		invalidate: () => editor.invalidate(),
		handleInput,
		get focused() { return editor.focused; },
		set focused(value: boolean) { editor.focused = value; },
		dispose,
	};
}
