/**
 * ask — Shared types and constants.
 *
 * Pure types/constants. No imports from sibling modules.
 */

import { Type } from "typebox";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const OptionSchema = Type.Object({
	value: Type.String({ description: "Machine-readable value returned to the agent when this option is picked" }),
	label: Type.String({ description: "Human-readable display label" }),
	description: Type.Optional(
		Type.String({ description: "Optional secondary line shown under the label" }),
	),
	preview: Type.Optional(
		Type.String({ description: "Optional multi-line preview (code, diff, layout) shown beside the options while this option is highlighted" }),
	),
});

export const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique question identifier" }),
	label: Type.Optional(
		Type.String({
			description:
				"Short tab-bar label, e.g. 'Scope', 'Priority' (default: Q1, Q2, ...). Truncated to 12 chars + … if longer.",
		}),
	),
	prompt: Type.String({ description: "Question text shown to the user" }),
	options: Type.Array(OptionSchema, { description: "Available options" }),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Allow free-text 'Other' input row (default: true)" }),
	),
	multi: Type.Optional(
		Type.Boolean({ description: "Allow selecting multiple options (default: false)" }),
	),
	recommended: Type.Optional(
		Type.Number({
			description:
				"0-indexed cursor pre-position. Marks the option as recommended. Cursor only — never pre-checks in multi-select mode.",
		}),
	),
	required: Type.Optional(
		Type.Boolean({ description: "Mark this question as required (advisory only; never blocks submission)" }),
	),
});

export const AskParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional title shown above the questions and included in the result" })),
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// ─── Runtime types ───────────────────────────────────────────────────────────

export interface IncomingOption {
	value: string;
	label: string;
	description?: string;
	preview?: string;
}

export interface IncomingQuestion {
	id: string;
	label?: string;
	prompt: string;
	options: IncomingOption[];
	allowOther?: boolean;
	multi?: boolean;
	recommended?: number;
	required?: boolean;
}

export interface NormalizedQuestion {
	id: string;
	rawLabel: string;
	tabLabel: string;
	prompt: string;
	options: IncomingOption[];
	allowOther: boolean;
	multi: boolean;
	recommended?: number;
	required: boolean;
}

export interface Answer {
	id: string;
	multi: boolean;
	wasCustom: boolean;
	values: string[];
	labels: string[];
	indices: number[];
	customInput?: string;
}

export interface AskNote {
	questionId: string;
	optionValue?: string;
	text: string;
}

export interface AskIssue {
	path: string;
	message: string;
}

export type AskMode = "submit" | "elaborate";

export interface AskDetails {
	title?: string;
	questions: IncomingQuestion[];
	answers: Answer[];
	notes: AskNote[];
	cancelled: boolean;
	/** True when the tool call was aborted before the user answered (cancelled is also true). */
	aborted?: boolean;
	mode: AskMode;
	error?: { issues: AskIssue[] };
}
