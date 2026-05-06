/**
 * ask — Pure formatting helpers (answer-line text, help bar, display value).
 *
 * Pure. Imports `./types` only.
 */

import type { Answer, NormalizedQuestion } from "./types.js";

/**
 * Returns the display string for an option's value/label pair.
 * If they differ, prefer `value`; otherwise return `label` (which equals value).
 */
export function displayValue(value: string, label: string): string {
	return value !== label ? value : label;
}

export function formatAnswerLine(
	q: NormalizedQuestion,
	answer: Answer | undefined,
): string {
	if (!answer) return `${q.rawLabel}: (unanswered)`;
	if (answer.wasCustom) {
		return `${q.rawLabel}: user wrote: ${answer.customInput ?? ""}`;
	}
	const idxs = answer.indices ?? [];
	if (idxs.length === 0) return `${q.rawLabel}: (unanswered)`;
	if (answer.multi) {
		const parts = idxs.map((idx, i) => {
			const v = answer.values[i];
			const l = answer.labels[i];
			return `${idx}. ${displayValue(v, l)}`;
		});
		return `${q.rawLabel}: user selected: ${parts.join(", ")}`;
	}
	const v = answer.values[0];
	const l = answer.labels[0];
	return `${q.rawLabel}: user selected: ${idxs[0]}. ${displayValue(v, l)}`;
}

export type HelpMode = "input" | "submit" | "question";

export interface HelpTextOptions {
	mode: HelpMode;
	multi: boolean;
	hasTabBar: boolean;
}

export function helpText(opts: HelpTextOptions): string {
	if (opts.mode === "input") return " Enter submit • Esc cancel input";
	if (opts.mode === "submit") return " Tab/←→ back • Enter submit • Esc cancel";
	// question mode
	const tabsHint = opts.hasTabBar ? " • Tab/←→ tabs" : "";
	if (opts.multi) {
		return ` ↑↓ navigate • Space toggle • Enter advance${tabsHint} • Esc cancel`;
	}
	return ` ↑↓ navigate • Enter select${tabsHint} • Esc cancel`;
}
