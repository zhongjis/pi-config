/**
 * ask — Input validation + normalization.
 *
 * Pure. Imports `./types` only.
 */

import type { AskDetails, AskIssue, IncomingQuestion, NormalizedQuestion } from "./types.js";

export type ValidateResult =
	| { ok: true }
	| { ok: false; issues: AskIssue[] };

export function validateInput(input: unknown): ValidateResult {
	const issues: AskIssue[] = [];
	if (!Array.isArray(input) || input.length === 0) {
		return { ok: false, issues: [{ path: "questions", message: "Must be a non-empty array" }] };
	}
	const ids = new Set<string>();
	const nonBlank = (value: unknown, path: string): value is string => {
		if (typeof value === "string" && value.trim().length > 0) return true;
		issues.push({ path, message: "Must be a non-blank string" });
		return false;
	};
	input.forEach((question: unknown, i) => {
		const q = question && typeof question === "object" ? question : {};
		const path = `questions[${i}]`;
		const id = "id" in q ? q.id : undefined;
		if (nonBlank(id, `${path}.id`)) {
			if (ids.has(id)) issues.push({ path: `${path}.id`, message: "Must be unique across questions" });
			ids.add(id);
		}
		nonBlank("prompt" in q ? q.prompt : undefined, `${path}.prompt`);
		const options = "options" in q && Array.isArray(q.options) ? q.options : [];
		if (options.length === 0) issues.push({ path: `${path}.options`, message: "Must contain at least one option" });
		const values = new Set<string>();
		options.forEach((option: unknown, j) => {
			const o = option && typeof option === "object" ? option : {};
			const op = `${path}.options[${j}]`;
			const value = "value" in o ? o.value : undefined;
			if (nonBlank(value, `${op}.value`)) {
				if (values.has(value)) issues.push({ path: `${op}.value`, message: "Must be unique within the question" });
				values.add(value);
			}
			nonBlank("label" in o ? o.label : undefined, `${op}.label`);
		});
		if ("recommended" in q && q.recommended !== undefined) {
			const r = q.recommended;
			if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r >= options.length) {
				issues.push({ path: `${path}.recommended`, message: "Must be an integer indexing an available option" });
			}
		}
	});
	return issues.length ? { ok: false, issues } : { ok: true };
}

export function buildInvalidDetails(input: IncomingQuestion[], title: string | undefined, issues: AskIssue[]): AskDetails {
	return { ...(title === undefined ? {} : { title }), questions: input, answers: [], notes: [], cancelled: true, mode: "submit", error: { issues } };
}

export function truncateTabLabel(label: string): string {
	return label.length > 12 ? `${label.slice(0, 12)}…` : label;
}

export function normalizeQuestions(input: IncomingQuestion[]): NormalizedQuestion[] {
	return input.map((q, i) => {
		const rawLabel = q.label && q.label.length > 0 ? q.label : `Q${i + 1}`;
		const recommended =
			q.recommended !== undefined &&
			Number.isInteger(q.recommended) &&
			q.recommended >= 0 &&
			q.recommended < q.options.length
				? q.recommended
				: undefined;
		return {
			id: q.id,
			rawLabel,
			tabLabel: truncateTabLabel(rawLabel),
			prompt: q.prompt,
			options: q.options,
			allowOther: q.allowOther !== false,
			multi: q.multi === true,
			required: q.required === true,
			recommended,
		};
	});
}
