/**
 * ask — Interactive component: state effects, editor, previews and rendering.
 *
 * Owns the abort listener for one interaction; completion and disposal remove it.
 * The pure AskState owns all decision semantics.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatAnswerLine, formatNoteLine } from "./format.js";
import { createAskKeys, type AskKeybindings } from "./keys.js";
import { AskState, type AskEffect } from "./state.js";
import { type AskDetails, type IncomingQuestion, type NormalizedQuestion, OTHER_LABEL, RECOMMENDED_SUFFIX } from "./types.js";

export interface AskDialogResult {
	details: AskDetails;
	aborted: boolean;
}

export interface AskDialogOptions {
	questions: NormalizedQuestion[];
	input: IncomingQuestion[];
	title?: string;
	tui: TUI;
	theme: Pick<Theme, "fg" | "bg" | "bold">;
	keybindings?: AskKeybindings;
	signal?: AbortSignal;
	done(result: AskDialogResult): void;
}

export function createAskDialog({ questions, input, title, tui, theme, keybindings, signal, done }: AskDialogOptions) {
	const state = new AskState(questions);
	const keys = createAskKeys(keybindings);
	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (s) => theme.fg("accent", s),
			selectedText: (s) => theme.fg("accent", s),
			description: (s) => theme.fg("muted", s),
			scrollInfo: (s) => theme.fg("dim", s),
			noMatch: (s) => theme.fg("warning", s),
		},
	};
	const editor = new Editor(tui, editorTheme);
	let finished = false;
	function dispose() {
		finished = true;
		signal?.removeEventListener("abort", onAbort);
		editor.focused = false;
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
			if (key?.kind === "cancel") state.cancelEditor(editor.getText());
			else editor.handleInput(data);
		} else apply(state.dispatch(key));
		refresh();
	}

	function wrapped(text: string, width: number, prefix = ""): string[] {
		return wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(prefix))).map((line) => `${prefix}${line}`);
	}
	function optionLines(q: NormalizedQuestion, width: number): string[] {
		const lines: string[] = [];
		q.options.forEach((option, i) => {
			const cursor = i === state.optionIndex;
			const mark = q.multi ? `${state.isOptionToggled(q.id, i) ? "☑" : "☐"} ` : "";
			const label = `${mark}${i + 1}. ${option.label}${q.recommended === i ? RECOMMENDED_SUFFIX : ""}`;
			lines.push(`${cursor ? "> " : "  "}${theme.fg(cursor ? "accent" : "text", label)}`);
			if (option.description) lines.push(...wrapped(theme.fg("muted", option.description), width, "    "));
			const note = state.getNote(q.id, i);
			if (note) lines.push(...wrapped(theme.fg("muted", `✎ ${note}`), width, "    "));
		});
		if (q.allowOther) {
			const custom = state.getCustomInput(q.id);
			const draft = state.getDraft({ kind: "custom", questionId: q.id });
			const cursor = state.isOtherRow(q, state.optionIndex);
			const mark = q.multi ? `${custom ? "☑" : "☐"} ` : "";
			const value = custom ? `: ${custom} ✎` : draft !== undefined ? ` (draft: ${draft})` : "";
			lines.push(`${cursor ? "> " : "  "}${theme.fg(cursor ? "accent" : "text", `${mark}${OTHER_LABEL}${value}`)}`);
		}
		return lines.map((line) => truncateToWidth(line, width));
	}
	function previewLines(q: NormalizedQuestion, width: number): string[] {
		const preview = q.options[state.optionIndex]?.preview;
		const all = preview === undefined ? [theme.fg("dim", "(no preview)")] : wrapped(preview, width);
		return [theme.fg("muted", "Preview"), ...all.slice(0, 12), ...(all.length > 12 ? [theme.fg("dim", `… +${all.length - 12} more lines`)] : [])];
	}
	function questionLines(q: NormalizedQuestion, width: number): string[] {
		const lines = wrapped(theme.fg("text", q.prompt), width, " ");
		const note = state.getNote(q.id);
		if (note) lines.push(...wrapped(theme.fg("muted", `✎ ${note}`), width, " "));
		lines.push("");
		if (!q.options.some((o) => o.preview !== undefined)) return [...lines, ...optionLines(q, width)];
		if (width >= 100) {
			const leftWidth = Math.floor((width - 3) * 0.45);
			const rightWidth = width - leftWidth - 3;
			const left = optionLines(q, leftWidth);
			const right = previewLines(q, rightWidth);
			for (let i = 0; i < Math.max(left.length, right.length); i++) {
				const row = left[i] ?? "";
				lines.push(`${row}${" ".repeat(leftWidth - visibleWidth(row))} ${theme.fg("dim", "│")} ${right[i] ?? ""}`);
			}
		} else {
			lines.push(...optionLines(q, width), theme.fg("dim", `┌${"─".repeat(Math.max(0, width - 2))}┐`));
			for (const line of previewLines(q, Math.max(1, width - 4))) {
				const cell = truncateToWidth(line, Math.max(1, width - 4));
				lines.push(`│ ${cell}${" ".repeat(Math.max(0, width - 4 - visibleWidth(cell)))} │`);
			}
			lines.push(theme.fg("dim", `└${"─".repeat(Math.max(0, width - 2))}┘`));
		}
		return lines;
	}
	function reviewLines(width: number): string[] {
		const lines = [theme.fg("accent", theme.bold("Review"))];
		for (const q of questions) {
			const answer = state.buildAnswer(q);
			lines.push(...wrapped(theme.fg(answer ? "text" : q.required ? "warning" : "dim", formatAnswerLine(q, answer)), width));
			for (const note of state.getNotes().filter((n) => n.questionId === q.id)) lines.push(...wrapped(theme.fg("muted", `✎ ${formatNoteLine(q, note).slice(2)}`), width, "  "));
		}
		lines.push("");
		["1 Submit", `2 Elaborate${state.elaborateEnabled ? "" : " (add a note first: n / N)"}`, "3 Cancel"].forEach((action, i) => {
			const color = i === 1 && !state.elaborateEnabled ? "dim" : i === state.reviewActionIndex ? "accent" : "text";
			lines.push(...wrapped(theme.fg(color, `${i === state.reviewActionIndex ? "> " : "  "}${action}`), width));
		});
		return lines;
	}
	function hint(): string {
		const confirm = keys.label("tui.select.confirm");
		const cancel = keys.label("tui.select.cancel");
		if (state.dismissPending) return `Press ${cancel} again to discard your answers`;
		if (state.editorTarget) return `${confirm} submit • ${cancel} cancel input`;
		const navigate = `${keys.label("tui.select.up")}/${keys.label("tui.select.down")} navigate`;
		const q = state.getCurrentQuestion();
		if (!q) return `${navigate} • 1–3 action • ${confirm} action • Tab/←→ tabs • ${cancel} dismiss`;
		const action = state.isOtherRow(q, state.optionIndex) ? "edit Other" : q.multi ? "advance" : "select";
		return `${navigate} • 1–9 ${q.multi ? "toggle" : "select"}${q.multi ? " • Space toggle" : ""} • ${confirm} ${action} • n option note / N question note • Tab/←→ tabs • ${cancel} dismiss`;
	}
	function render(width: number): string[] {
		width = Math.max(0, Math.floor(width));
		const lines = [theme.fg("accent", "─".repeat(width))];
		if (title !== undefined) lines.push(...wrapped(theme.fg("accent", theme.bold(title)), width));
		if (state.hasTabBar) {
			const cells = questions.map((q, i) => {
				const text = ` ${state.isAnswered(q) ? "■" : "□"} ${q.tabLabel}${q.required ? "*" : ""} `;
				return i === state.currentTab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(q.required && !state.isAnswered(q) ? "warning" : state.isAnswered(q) ? "success" : "muted", text);
			});
			cells.push(state.currentTab === questions.length ? theme.bg("selectedBg", " ✓ Review ") : theme.fg("muted", " ✓ Review "));
			lines.push(cells.join(" "), "");
		}
		const q = state.getCurrentQuestion();
		if (state.editorTarget && q) {
			lines.push(...wrapped(theme.fg("text", q.prompt), width, " "));
			const target = state.editorTarget;
			const label = target.kind === "custom" ? "Your answer:" : `Note for ${q.rawLabel}${target.optionIndex === undefined ? "" : ` › ${q.options[target.optionIndex].label}`}:`;
			lines.push(...wrapped(theme.fg("muted", label), width, " "));
			lines.push(...editor.render(Math.max(1, width - 2)).map((line) => ` ${line}`));
		} else lines.push(...(q ? questionLines(q, width) : reviewLines(width)));
		lines.push("", ...wrapped(theme.fg(state.dismissPending ? "warning" : "dim", hint()), width), theme.fg("accent", "─".repeat(width)));
		return lines.map((line) => truncateToWidth(line, width));
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
