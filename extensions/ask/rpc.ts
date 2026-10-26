/**
 * ask — RPC dialog driver: answers through Pi's extension UI dialog methods only.
 *
 * Follows Pi's RPC extension UI protocol (docs/rpc-extension-ui.md): `select`,
 * `input` and `editor` block until the client responds, so every answer, preview
 * and note travels through them. Fire-and-forget methods may be ignored by the
 * client and carry nothing here. Choices are plain strings mapped back by row.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { humanAnswer } from "./format.js";
import type { Answer, AskDetails, AskMode, IncomingQuestion, NormalizedQuestion } from "./types.js";

export const OTHER = "Other…";
export const ADD_NOTE = "Add note…";
export const EDIT_NOTE = "Edit note…";
export const PREVIEWS = "Show previews…";
export const SKIP = "Skip";
export const DONE = "Done";
export const SUBMIT = "Submit";
export const ELABORATE = "Elaborate";
export const CANCEL = "Cancel";

export type DialogUI = Pick<ExtensionUIContext, "select" | "input" | "editor">;

type Action =
	| { kind: "option"; index: number }
	| { kind: "other" | "note" | "previews" | "next" };

/** Numbered so every row is unique and never collides with the fixed action rows. */
function optionLabel(q: NormalizedQuestion, i: number): string {
	const o = q.options[i];
	return `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}${i === q.recommended ? " (recommended)" : ""}`;
}

function previewText(q: NormalizedQuestion): string {
	return q.options.map((o, i) => `${i + 1}. ${o.label}\n${o.preview ?? "(no preview)"}`).join("\n\n");
}

/**
 * Ask every question through blocking dialogs and return the same details the TUI
 * dialog builds. Mirrors AskState: one single-select question submits on selection
 * without notes; otherwise Review offers Submit, Elaborate (only with notes) and Cancel.
 * ponytail: notes attach to questions, not options; per-option notes need the TUI dialog.
 */
export async function askViaDialogs(
	ui: DialogUI,
	questions: NormalizedQuestion[],
	input: IncomingQuestion[],
	title: string | undefined,
	signal?: AbortSignal,
): Promise<AskDetails> {
	const singles = new Map<string, number>();
	const multis = new Map<string, Set<number>>();
	const customs = new Map<string, string>();
	const notes = new Map<string, string>();

	const answerOf = (q: NormalizedQuestion): Answer | undefined => {
		const selected = q.multi ? [...(multis.get(q.id) ?? [])].sort((a, b) => a - b) : singles.has(q.id) ? [singles.get(q.id)!] : [];
		const customInput = customs.get(q.id);
		if (selected.length === 0 && customInput === undefined) return undefined;
		return {
			id: q.id,
			multi: q.multi,
			wasCustom: customInput !== undefined,
			values: selected.map((i) => q.options[i].value),
			labels: selected.map((i) => q.options[i].label),
			indices: selected.map((i) => i + 1),
			...(customInput === undefined ? {} : { customInput }),
		};
	};
	const finish = (result: { cancelled: true } | { mode: AskMode }): AskDetails => ({
		...(title === undefined ? {} : { title }),
		questions: input,
		answers: questions.map(answerOf).filter((a): a is Answer => a !== undefined),
		notes: questions.flatMap((q) => {
			const text = notes.get(q.id);
			return text ? [{ questionId: q.id, text }] : [];
		}),
		cancelled: "cancelled" in result,
		mode: "mode" in result ? result.mode : "submit",
		...(signal?.aborted ? { aborted: true } : {}),
	});
	const cancelled = () => finish({ cancelled: true });
	const quickPick = questions.length === 1 && !questions[0].multi;

	for (const q of questions) {
		const head = `${q.rawLabel}: ${q.prompt}${q.required ? " [required]" : ""}`;
		const picked = multis.get(q.id) ?? new Set<number>();
		if (q.multi) multis.set(q.id, picked);
		for (;;) {
			if (signal?.aborted) return cancelled();
			const rows: { label: string; action: Action }[] = q.options.map((_, i) => ({
				label: q.multi ? `${picked.has(i) ? "☑" : "☐"} ${optionLabel(q, i)}` : optionLabel(q, i),
				action: { kind: "option", index: i },
			}));
			if (q.allowOther) rows.push({ label: customs.has(q.id) ? `${OTHER} “${customs.get(q.id)}”` : OTHER, action: { kind: "other" } });
			if (q.options.some((o) => o.preview !== undefined)) rows.push({ label: PREVIEWS, action: { kind: "previews" } });
			rows.push({ label: notes.has(q.id) ? EDIT_NOTE : ADD_NOTE, action: { kind: "note" } });
			if (q.multi) rows.push({ label: DONE, action: { kind: "next" } });
			else if (!quickPick) rows.push({ label: SKIP, action: { kind: "next" } });

			const choice = await ui.select(head, rows.map((r) => r.label), { signal });
			const action = rows.find((r) => r.label === choice)?.action;
			if (!action || signal?.aborted) return cancelled();
			if (action.kind === "next") break;
			if (action.kind === "option") {
				if (!q.multi) {
					singles.set(q.id, action.index);
					customs.delete(q.id);
					break;
				}
				if (picked.has(action.index)) picked.delete(action.index);
				else picked.add(action.index);
				continue;
			}
			if (action.kind === "previews") {
				await ui.editor(`Previews — ${q.rawLabel}`, previewText(q));
				continue;
			}
			if (action.kind === "note") {
				const text = await ui.editor(`Note — ${q.rawLabel}`, notes.get(q.id) ?? "");
				// Cancelling the editor keeps the previous note, like the TUI draft rule.
				if (text !== undefined) {
					if (text.trim()) notes.set(q.id, text.trim());
					else notes.delete(q.id);
				}
				continue;
			}
			const text = await ui.input(head, "Type your answer", { signal });
			if (signal?.aborted) return cancelled();
			if (text === undefined) continue;
			if (!text.trim()) {
				customs.delete(q.id);
				continue;
			}
			customs.set(q.id, text.trim());
			if (!q.multi) {
				singles.delete(q.id);
				break;
			}
		}
	}

	if (quickPick && notes.size === 0) return finish({ mode: "submit" });
	const summary = questions.map((q) => `${q.rawLabel}: ${humanAnswer(answerOf(q)) ?? `(no answer)${q.required ? " [required]" : ""}`}`);
	const choice = await ui.select(["Review", ...summary].join("\n"), [SUBMIT, ...(notes.size > 0 ? [ELABORATE] : []), CANCEL], { signal });
	if (signal?.aborted) return cancelled();
	if (choice === SUBMIT) return finish({ mode: "submit" });
	if (choice === ELABORATE) return finish({ mode: "elaborate" });
	return cancelled();
}
