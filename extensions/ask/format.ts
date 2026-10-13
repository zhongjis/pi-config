/**
 * ask — Pure result text, question-list and display formatting.
 *
 * Pure. Imports `./types` only.
 */

import type { Answer, AskDetails, AskIssue, AskNote, NormalizedQuestion } from "./types.js";

/** Prefer the machine value when it differs from the display label. */
export function displayValue(value: string, label: string): string {
	return value !== label ? value : label;
}

/** Human-facing answer: picked option labels, then typed text in quotes. Undefined when unanswered. */
export function humanAnswer(answer: Answer | undefined): string | undefined {
	if (!answer) return undefined;
	const parts = [...(answer.labels ?? [])];
	if (answer.customInput) parts.push(`“${answer.customInput}”`);
	return parts.length ? parts.join(", ") : undefined;
}

/** Human-facing note text, prefixed with the option label for option notes. */
export function humanNote(q: Pick<NormalizedQuestion, "options">, note: AskNote): string {
	const label = note.optionValue === undefined ? undefined : q.options.find((o) => o.value === note.optionValue)?.label;
	return label === undefined ? note.text : `${label}: ${note.text}`;
}

export function formatAnswerLine(q: NormalizedQuestion, answer: Answer | undefined): string {
	const parts: string[] = [];
	if (answer?.indices.length) {
		const selected = answer.indices.map((idx, i) =>
			`${idx}. ${displayValue(answer.values[i], answer.labels[i])}`,
		);
		parts.push(`user selected: ${selected.join(", ")}`);
	}
	if (answer?.customInput) parts.push(`user wrote: ${answer.customInput}`);
	return `${q.rawLabel}: ${parts.length ? parts.join("; ") : `(no answer)${q.required ? " [required]" : ""}`}`;
}

export function formatNoteLine(q: NormalizedQuestion, note: AskNote): string {
	const idx = note.optionValue === undefined ? -1 : q.options.findIndex((o) => o.value === note.optionValue);
	const option = idx < 0 ? "" : ` › ${idx + 1}. ${displayValue(q.options[idx].value, q.options[idx].label)}`;
	return `${q.rawLabel}${option}: ${note.text}`;
}

export function formatInvalidPayload(issues: AskIssue[]): string {
	return `Invalid ask payload:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`;
}

export function formatResultText(questions: NormalizedQuestion[], details: AskDetails, aborted = false): string {
	if (details.error) return formatInvalidPayload(details.error.issues);
	if (aborted) return "Ask was aborted before the user answered.";
	if (details.cancelled) return "User cancelled the questions.";
	const lines: string[] = [];
	if (details.mode === "elaborate") {
		lines.push(
			"The user wants clarification before finalizing (mode: elaborate).",
			"Respond to each note first. Then call ask again only for questions that still need a decision; keep the answers below.",
		);
	}
	if (details.title !== undefined) lines.push(details.title);
	for (const q of questions) lines.push(formatAnswerLine(q, details.answers.find((a) => a.id === q.id)));
	if (details.notes.length) {
		lines.push("Notes:");
		for (const q of questions) {
			for (const note of details.notes.filter((n) => n.questionId === q.id)) lines.push(`- ${formatNoteLine(q, note)}`);
		}
	}
	return lines.join("\n");
}

export function formatNonTuiQuestions(questions: NormalizedQuestion[]): string {
	const lines = ["Needs user input: the ask tool requires interactive TUI mode. Ask the user these questions directly:"];
	questions.forEach((q, i) => {
		lines.push(`${i + 1}. ${q.rawLabel}: ${q.prompt} (${q.multi ? "choose any" : "choose one"})`);
		q.options.forEach((o, j) => {
			lines.push(`   ${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
		});
		if (q.allowOther) lines.push("   Other: free text allowed");
	});
	return lines.join("\n");
}
