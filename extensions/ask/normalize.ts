/**
 * ask — Input validation + normalization.
 *
 * Pure. Imports `./types` only.
 */

import type { IncomingQuestion, NormalizedQuestion } from "./types.js";

export type ValidateResult =
	| { ok: true }
	| { ok: false; error: string };

export function validateInput(input: IncomingQuestion[]): ValidateResult {
	if (!input || input.length === 0) {
		return { ok: false, error: "Error: at least one question must be provided" };
	}
	for (const q of input) {
		if (!q.options || q.options.length === 0) {
			return {
				ok: false,
				error: `Error: question '${q.id}' has no options; provide at least one option per question`,
			};
		}
	}
	return { ok: true };
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
			recommended,
		};
	});
}
