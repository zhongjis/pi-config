/**
 * ask — Interactive user prompting tool
 *
 * Restructured 2026: based on `questionnaire.ts` from `badlogic/pi-mono` examples
 * (tab-bar UI, Submit-tab pattern, render structure, Answer detail shape), with
 * multi-select / recommended / word-wrap / `user-prompted` event-emit features
 * merged from the prior oh-my-pi-derived implementation. Empty-options runtime
 * guard donated from `question.ts`.
 *
 * Sources:
 *   - https://github.com/badlogic/pi-mono   (questionnaire.ts, question.ts)
 *   - https://github.com/can1357/oh-my-pi   (original ask tool lineage)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Schema ──────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	value: Type.String({ description: "Machine-readable value returned to the agent when this option is picked" }),
	label: Type.String({ description: "Human-readable display label" }),
	description: Type.Optional(
		Type.String({ description: "Optional secondary line shown under the label" }),
	),
});

const QuestionSchema = Type.Object({
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
				"0-indexed cursor pre-position. Adds '(Recommended)' to the option label. Cursor only — never pre-checks in multi-select mode.",
		}),
	),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// ─── Types ───────────────────────────────────────────────────────────────────

interface IncomingOption {
	value: string;
	label: string;
	description?: string;
}

interface IncomingQuestion {
	id: string;
	label?: string;
	prompt: string;
	options: IncomingOption[];
	allowOther?: boolean;
	multi?: boolean;
	recommended?: number;
}

interface NormalizedQuestion {
	id: string;
	rawLabel: string;
	tabLabel: string;
	prompt: string;
	options: IncomingOption[];
	allowOther: boolean;
	multi: boolean;
	recommended?: number;
}

interface Answer {
	id: string;
	multi: boolean;
	wasCustom: boolean;
	values: string[];
	labels: string[];
	indices?: number[];
	customInput?: string;
}

interface AskDetails {
	questions: IncomingQuestion[];
	answers: Answer[];
	cancelled: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RECOMMENDED_SUFFIX = " (Recommended)";
const OTHER_LABEL = "Other (type your own)";

function truncateTabLabel(label: string): string {
	return label.length > 12 ? `${label.slice(0, 12)}…` : label;
}

function displayValue(opt: IncomingOption): string {
	return opt.value !== opt.label ? opt.value : opt.label;
}

function formatAnswerLine(q: NormalizedQuestion, answer: Answer | undefined): string {
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
			const d = v !== l ? v : l;
			return `${idx}. ${d}`;
		});
		return `${q.rawLabel}: user selected: ${parts.join(", ")}`;
	}
	const v = answer.values[0];
	const l = answer.labels[0];
	const d = v !== l ? v : l;
	return `${q.rawLabel}: user selected: ${idxs[0]}. ${d}`;
}

function errorResult(message: string, input: IncomingQuestion[] = []): {
	content: { type: "text"; text: string }[];
	details: AskDetails;
} {
	return {
		content: [{ type: "text", text: message }],
		details: { questions: input, answers: [], cancelled: true },
	};
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: [
			"Ask the user one or more questions during task execution.",
			"Use to gather preferences, clarify ambiguous instructions, or confirm implementation choices.",
			"",
			"- questions: array of { id, prompt, options, label?, allowOther?, multi?, recommended? }",
			"- options: array of { value, label, description? }; value is fed back to the agent, label is shown to the user",
			"- multi: true enables Space-to-toggle checkbox selection; Enter advances to the next tab",
			"- recommended: 0-indexed cursor position (single or multi); shown as '(Recommended)'; never pre-checks in multi mode",
			"- allowOther: shows an 'Other (type your own)' row that opens an inline editor (default: true)",
			"- For multiple questions, a tab bar lets the user navigate with Tab / Shift+Tab / ←→ between questions and a Submit tab",
		].join("\n"),
		parameters: AskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const inputQuestions = (params.questions as IncomingQuestion[]) ?? [];

			if (!ctx.hasUI) {
				return errorResult("Error: ask tool requires interactive mode", inputQuestions);
			}
			if (inputQuestions.length === 0) {
				return errorResult("Error: at least one question must be provided", inputQuestions);
			}
			for (const q of inputQuestions) {
				if (!q.options || q.options.length === 0) {
					return errorResult(
						`Error: question '${q.id}' has no options; provide at least one option per question`,
						inputQuestions,
					);
				}
			}

			const questions: NormalizedQuestion[] = inputQuestions.map((q, i) => {
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

			// Auto-skip Submit tab when there is exactly 1 single-select question.
			const autoFinalize = questions.length === 1 && !questions[0].multi;
			const totalTabs = autoFinalize ? 1 : questions.length + 1;
			const hasTabBar = !autoFinalize;

			pi.events.emit("user-prompted", { tool: "ask" });

			const outcome = await ctx.ui.custom<AskDetails>((tui, theme, _kb, done) => {
				// ── State ─────────────────────────────────────────────────────────
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;

				const singleAnswers = new Map<string, number>(); // qId -> chosen option index
				const multiSets = new Map<string, Set<number>>(); // qId -> set of toggled option indices
				const customInputs = new Map<string, string>(); // qId -> free text
				const lastCursor = new Map<string, number>(); // qId -> last cursor position
				const visited = new Set<string>();

				// ── Editor for "Other" free-text input ────────────────────────────
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// ── Helpers ───────────────────────────────────────────────────────
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function getMultiSet(qId: string): Set<number> {
					let s = multiSets.get(qId);
					if (!s) {
						s = new Set();
						multiSets.set(qId, s);
					}
					return s;
				}

				function isAnswered(q: NormalizedQuestion): boolean {
					if (customInputs.has(q.id)) return true;
					if (q.multi) {
						const s = multiSets.get(q.id);
						return !!s && s.size > 0;
					}
					return singleAnswers.has(q.id);
				}

				function allAnswered(): boolean {
					return questions.every(isAnswered);
				}

				function buildAnswer(q: NormalizedQuestion): Answer | undefined {
					if (customInputs.has(q.id)) {
						return {
							id: q.id,
							multi: q.multi,
							wasCustom: true,
							values: [],
							labels: [],
							customInput: customInputs.get(q.id),
						};
					}
					if (q.multi) {
						const s = multiSets.get(q.id);
						if (!s || s.size === 0) return undefined;
						const sorted = Array.from(s).sort((a, b) => a - b);
						return {
							id: q.id,
							multi: true,
							wasCustom: false,
							values: sorted.map((i) => q.options[i].value),
							labels: sorted.map((i) => q.options[i].label),
							indices: sorted.map((i) => i + 1),
						};
					}
					const idx = singleAnswers.get(q.id);
					if (idx === undefined) return undefined;
					return {
						id: q.id,
						multi: false,
						wasCustom: false,
						values: [q.options[idx].value],
						labels: [q.options[idx].label],
						indices: [idx + 1],
					};
				}

				function finalize(cancelled: boolean) {
					const answers = questions
						.map(buildAnswer)
						.filter((a): a is Answer => a !== undefined);
					done({
						questions: inputQuestions,
						answers,
						cancelled,
					});
				}

				function totalRows(q: NormalizedQuestion): number {
					return q.options.length + (q.allowOther ? 1 : 0);
				}

				function isOtherRow(q: NormalizedQuestion, i: number): boolean {
					return q.allowOther && i === q.options.length;
				}

				function rememberCursor() {
					if (currentTab >= 0 && currentTab < questions.length) {
						lastCursor.set(questions[currentTab].id, optionIndex);
					}
				}

				function enterTab(idx: number) {
					currentTab = idx;
					if (idx < questions.length) {
						const q = questions[idx];
						if (visited.has(q.id)) {
							optionIndex = lastCursor.get(q.id) ?? 0;
						} else {
							visited.add(q.id);
							optionIndex = q.recommended ?? 0;
						}
					} else {
						optionIndex = 0; // Submit tab
					}
					refresh();
				}

				function advanceAfterAnswer() {
					if (autoFinalize) {
						finalize(false);
						return;
					}
					rememberCursor();
					if (currentTab < questions.length - 1) {
						enterTab(currentTab + 1);
					} else {
						currentTab = questions.length; // Submit tab
						optionIndex = 0;
						refresh();
					}
				}

				// ── Editor submit ────────────────────────────────────────────────
				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (!inputQuestionId) {
						inputMode = false;
						editor.setText("");
						refresh();
						return;
					}
					if (!trimmed) {
						// Empty input: drop back to options without saving.
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
						refresh();
						return;
					}
					const q = questions.find((qq) => qq.id === inputQuestionId);
					if (q) {
						// Other ↔ option mutual exclusion: clear any prior toggles / single pick.
						multiSets.delete(q.id);
						singleAnswers.delete(q.id);
						customInputs.set(q.id, trimmed);
					}
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				// ── Input handling ────────────────────────────────────────────────
				function handleInput(data: string) {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					// Tab navigation when there is more than one tab
					if (totalTabs > 1) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							rememberCursor();
							enterTab((currentTab + 1) % totalTabs);
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							rememberCursor();
							enterTab((currentTab - 1 + totalTabs) % totalTabs);
							return;
						}
					}

					if (matchesKey(data, Key.escape)) {
						finalize(true);
						return;
					}

					// Submit tab (only present when !autoFinalize)
					if (!autoFinalize && currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							finalize(false);
						}
						return;
					}

					const q = questions[currentTab];
					const rows = totalRows(q);

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(rows - 1, optionIndex + 1);
						refresh();
						return;
					}

					const onOther = isOtherRow(q, optionIndex);

					if (matchesKey(data, Key.enter)) {
						if (onOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						if (q.multi) {
							// Enter advances; it does NOT toggle in multi mode.
							rememberCursor();
							if (currentTab < questions.length - 1) {
								enterTab(currentTab + 1);
							} else {
								currentTab = questions.length;
								optionIndex = 0;
								refresh();
							}
							return;
						}
						// Single-select: pick the option and advance.
						customInputs.delete(q.id); // clear any prior custom input
						singleAnswers.set(q.id, optionIndex);
						advanceAfterAnswer();
						return;
					}

					if (q.multi && matchesKey(data, Key.space) && !onOther) {
						// Toggling clears any prior custom input for this question.
						customInputs.delete(q.id);
						const set = getMultiSet(q.id);
						if (set.has(optionIndex)) set.delete(optionIndex);
						else set.add(optionIndex);
						refresh();
						return;
					}
				}

				// ── Render ────────────────────────────────────────────────────────
				function renderTabBar(width: number, lines: string[]) {
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					const cells: string[] = [];
					for (let i = 0; i < questions.length; i++) {
						const q = questions[i];
						const answered = isAnswered(q);
						const isActive = i === currentTab;
						const box = answered ? "■" : "□";
						const text = ` ${box} ${q.tabLabel} `;
						const styled = isActive
							? theme.bg("selectedBg", theme.fg("text", text))
							: theme.fg(answered ? "success" : "muted", text);
						cells.push(styled);
					}
					const isSubmitTab = currentTab === questions.length;
					const submitText = " ✓ Submit ";
					const submitStyled = isSubmitTab
						? theme.bg("selectedBg", theme.fg("text", submitText))
						: theme.fg(allAnswered() ? "success" : "dim", submitText);
					cells.push(submitStyled);
					add(` ${cells.join(" ")}`);
					lines.push("");
				}

				function renderQuestionTab(width: number, lines: string[]) {
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					const q = questions[currentTab];

					// Question prompt — word-wrap
					for (const wl of wrapTextWithAnsi(theme.fg("text", q.prompt), width - 2)) {
						add(` ${wl}`);
					}
					lines.push("");

					const isCustomActive = customInputs.has(q.id);
					const set = q.multi ? multiSets.get(q.id) : undefined;

					for (let i = 0; i < q.options.length; i++) {
						const opt = q.options[i];
						const isCursor = i === optionIndex;
						const cursorPrefix = isCursor ? theme.fg("accent", "> ") : "  ";
						let displayLabel = `${i + 1}. ${opt.label}`;
						if (q.recommended === i) displayLabel += RECOMMENDED_SUFFIX;
						const mark = q.multi ? (!isCustomActive && set?.has(i) ? "☑ " : "☐ ") : "";
						const text = `${mark}${displayLabel}`;
						if (isCursor) add(`${cursorPrefix}${theme.fg("accent", text)}`);
						else add(`  ${theme.fg("text", text)}`);

						if (opt.description) {
							const wrapped = wrapTextWithAnsi(theme.fg("muted", opt.description), width - 7);
							for (const wl of wrapped) {
								add(`     ${wl}`);
							}
						}
					}

					if (q.allowOther) {
						const i = q.options.length;
						const isCursor = i === optionIndex;
						const cursorPrefix = isCursor ? theme.fg("accent", "> ") : "  ";
						const otherText = isCustomActive
							? `${OTHER_LABEL}: ${customInputs.get(q.id)} ✎`
							: OTHER_LABEL;
						if (isCursor) add(`${cursorPrefix}${theme.fg("accent", otherText)}`);
						else add(`  ${theme.fg(isCustomActive ? "accent" : "text", otherText)}`);
					}
				}

				function renderSubmitTab(width: number, lines: string[]) {
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					add(theme.fg("accent", theme.bold(" Ready to submit")));
					lines.push("");
					for (const q of questions) {
						const a = buildAnswer(q);
						const line = formatAnswerLine(q, a);
						const color = a ? "text" : "dim";
						add(` ${theme.fg(color, line)}`);
					}
					lines.push("");
					if (allAnswered()) {
						add(theme.fg("success", " Press Enter to submit"));
					} else {
						const missing = questions
							.filter((q) => !isAnswered(q))
							.map((q) => q.rawLabel)
							.join(", ");
						add(theme.fg("warning", ` Unanswered: ${missing}`));
					}
				}

				function renderInputMode(width: number, lines: string[]) {
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					const q = questions[currentTab];
					for (const wl of wrapTextWithAnsi(theme.fg("text", q.prompt), width - 2)) {
						add(` ${wl}`);
					}
					lines.push("");
					add(theme.fg("muted", " Your answer:"));
					for (const line of editor.render(width - 2)) {
						add(` ${line}`);
					}
				}

				function helpText(): string {
					if (inputMode) return " Enter submit • Esc cancel input";
					if (!autoFinalize && currentTab === questions.length) {
						return " Tab/←→ back • Enter submit • Esc cancel";
					}
					const q = questions[currentTab];
					const tabsHint = totalTabs > 1 ? " • Tab/←→ tabs" : "";
					if (q.multi) {
						return ` ↑↓ navigate • Space toggle • Enter advance${tabsHint} • Esc cancel`;
					}
					return ` ↑↓ navigate • Enter select${tabsHint} • Esc cancel`;
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));

					if (hasTabBar) renderTabBar(width, lines);

					if (inputMode) {
						renderInputMode(width, lines);
					} else if (!autoFinalize && currentTab === questions.length) {
						renderSubmitTab(width, lines);
					} else {
						renderQuestionTab(width, lines);
					}

					lines.push("");
					add(theme.fg("dim", helpText()));
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				enterTab(0);

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (outcome.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questions." }],
					details: outcome,
				};
			}

			const lines = questions.map((q) => {
				const answer = outcome.answers.find((a) => a.id === q.id);
				return formatAnswerLine(q, answer);
			});

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: outcome,
			};
		},

		// ─── renderCall ──────────────────────────────────────────────────────
		renderCall(args, theme, _context) {
			const qs: IncomingQuestion[] = Array.isArray(args.questions) ? args.questions : [];
			let text = theme.fg("toolTitle", theme.bold("ask "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);

			const flags: string[] = [];
			if (qs.some((q) => q?.multi === true)) flags.push("multi");
			if (qs.some((q) => typeof q?.recommended === "number")) flags.push("recommended");
			if (flags.length > 0) text += theme.fg("dim", ` [${flags.join(", ")}]`);

			for (const q of qs) {
				if (!q) continue;
				const tag = q.multi ? theme.fg("dim", " [multi]") : "";
				const rec =
					typeof q.recommended === "number" ? theme.fg("dim", ` [rec=${q.recommended}]`) : "";
				const lbl = q.label && q.label.length > 0 ? q.label : q.id;
				text += `\n  ${theme.fg("dim", `[${lbl}]`)} ${theme.fg("text", q.prompt ?? "")}${tag}${rec}`;
			}

			return new Text(text, 0, 0);
		},

		// ─── renderResult ────────────────────────────────────────────────────
		renderResult(result, _options, theme, _context) {
			const d = result.details as AskDetails | undefined;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			if (d.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			if (!d.answers || d.answers.length === 0) {
				return new Text(theme.fg("warning", "No answers"), 0, 0);
			}

			const lines = d.answers.map((a) => {
				const inputQ = d.questions.find((q) => q.id === a.id);
				const labelRaw = inputQ?.label && inputQ.label.length > 0 ? inputQ.label : a.id;
				const id = theme.fg("dim", `[${labelRaw}]`);
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${id} ${theme.fg("muted", "(wrote) ")}${theme.fg("accent", a.customInput ?? "")}`;
				}
				const idxs = a.indices ?? [];
				const parts = idxs.map((idx, i) => {
					const v = a.values[i];
					const l = a.labels[i];
					const opt: IncomingOption = { value: v, label: l };
					return `${idx}. ${displayValue(opt)}`;
				});
				return `${theme.fg("success", "✓ ")}${id} ${theme.fg("accent", parts.join(", "))}`;
			});

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
