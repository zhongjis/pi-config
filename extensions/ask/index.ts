/**
 * Ask Tool - Interactive user prompting during execution
 *
 * Adapted from oh-my-pi's ask tool (https://github.com/can1357/oh-my-pi).
 * Supports single and multi-question flows, multi-select, recommended options,
 * "Other" custom text input, and left/right navigation between questions.
 *
 * Key features over the original question tool:
 *   - Multiple questions in one call, with ←/→ navigation between them
 *   - multi: true enables checkbox-style multi-selection
 *   - recommended: <index> marks the default option (0-indexed)
 *   - "Other (type your own)" always available for free-text answers
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "typebox";

// ─── Schema ──────────────────────────────────────────────────────────────────

const OptionItem = Type.Object({
  label: Type.String({ description: "Display label" }),
});

const QuestionItem = Type.Object({
  id: Type.String({ description: "Unique question ID, e.g. 'auth', 'cache'" }),
  question: Type.String({ description: "Question text to display" }),
  options: Type.Array(OptionItem, { description: "Available options" }),
  multi: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options" })),
  recommended: Type.Optional(
    Type.Number({ description: "0-indexed position of the recommended/default option" }),
  ),
});

const AskParams = Type.Object({
  questions: Type.Array(QuestionItem, {
    description: "Questions to ask the user",
    minItems: 1,
  }),
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface QuestionResult {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

interface AskDetails {
  // Single-question mode
  question?: string;
  options?: string[];
  multi?: boolean;
  selectedOptions?: string[];
  customInput?: string;
  // Multi-question mode
  results?: QuestionResult[];
}

interface AskOutcome {
  results: QuestionResult[];
  cancelled: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RECOMMENDED_SUFFIX = " (Recommended)";
const OTHER_LABEL = "Other (type your own)";
const DONE_LABEL = "✓ Done selecting";

function addRecommended(labels: string[], idx?: number): string[] {
  if (idx == null || idx < 0 || idx >= labels.length) return labels;
  return labels.map((l, i) => (i === idx ? l + RECOMMENDED_SUFFIX : l));
}

function stripRecommended(label: string): string {
  return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
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
      "- questions: array of questions, each with id, question text, and options",
      "- multi: true enables checkbox-style multi-selection for a question",
      "- recommended: <index> marks the default option (0-indexed); adds '(Recommended)' suffix",
      "- Users can always type a custom answer via 'Other (type your own)'",
      "- For multiple questions, left/right arrows navigate between them",
    ].join("\n"),
    parameters: AskParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: User prompt requires interactive mode" }],
          details: {} as AskDetails,
        };
      }
      if (params.questions.length === 0) {
        return {
          content: [{ type: "text", text: "Error: questions must not be empty" }],
          details: {} as AskDetails,
        };
      }

      const questions = params.questions;
      const isMultiQ = questions.length > 1;

      pi.events.emit("user-prompted", { tool: "ask" });
      const outcome = await ctx.ui.custom<AskOutcome>((tui, theme, _kb, done) => {
        // ── Persisted state (one slot per question) ───────────────────────────
        const saved: (QuestionResult | undefined)[] = Array.from({ length: questions.length });
        // Multi-select sets, keyed by question index
        const multiSets = new Map<number, Set<string>>();

        // ── Active cursor state ───────────────────────────────────────────────
        let qIdx = 0;
        let optionIndex = 0;
        let editMode = false;
        let cachedLines: string[] | undefined;

        // ── Helpers ───────────────────────────────────────────────────────────

        function getMultiSet(i: number): Set<string> {
          let s = multiSets.get(i);
          if (!s) {
            s = new Set();
            multiSets.set(i, s);
          }
          return s;
        }

        /** Build the display option list for question i. */
        function getOptions(i: number): string[] {
          const q = questions[i];
          const labels = q.options.map((o) => o.label);
          if (q.multi) {
            const sel = getMultiSet(i);
            const opts = labels.map((l) => `${sel.has(l) ? "☑" : "☐"} ${l}`);
            // Show explicit "Done" only in single-question mode; in multi-Q mode use right arrow
            if (!isMultiQ) opts.push(DONE_LABEL);
            opts.push(OTHER_LABEL);
            return opts;
          }
          return [...addRecommended(labels, q.recommended), OTHER_LABEL];
        }

        /** Restore cursor for question i based on saved answer. */
        function loadQuestion(i: number) {
          qIdx = i;
          editMode = false;
          const q = questions[i];
          const prev = saved[i];
          optionIndex = q.recommended ?? 0;

          if (prev) {
            if (q.multi) {
              const set = getMultiSet(i);
              set.clear();
              for (const o of prev.selectedOptions) set.add(o);
            } else if (prev.customInput !== undefined) {
              optionIndex = getOptions(i).length - 1; // "Other" is always last
            } else if (prev.selectedOptions.length > 0) {
              const rawIdx = q.options.findIndex((o) => o.label === prev.selectedOptions[0]);
              if (rawIdx >= 0) optionIndex = rawIdx;
            }
          }
        }

        /** Snapshot current question state into saved[]. */
        function saveQuestion(i: number) {
          const q = questions[i];
          const labels = q.options.map((o) => o.label);
          if (q.multi) {
            saved[i] = {
              id: q.id,
              question: q.question,
              options: labels,
              multi: true,
              selectedOptions: Array.from(getMultiSet(i)),
            };
          } else {
            // For single-select, saved[i] is written directly on selection;
            // this call just ensures an empty slot exists if user skipped.
            saved[i] ??= {
              id: q.id,
              question: q.question,
              options: labels,
              multi: false,
              selectedOptions: [],
            };
          }
        }

        function finalize() {
          const results = questions.map(
            (q, i) =>
              saved[i] ?? {
                id: q.id,
                question: q.question,
                options: q.options.map((o) => o.label),
                multi: q.multi ?? false,
                selectedOptions: [],
              },
          );
          done({ results, cancelled: false });
        }

        function refresh() {
          cachedLines = undefined;
          tui.requestRender();
        }

        // ── Editor (for "Other" free-text input) ─────────────────────────────

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

        editor.onSubmit = (value) => {
          const trimmed = value.trim();
          editMode = false;
          editor.setText("");
          if (trimmed) {
            const q = questions[qIdx];
            saved[qIdx] = {
              id: q.id,
              question: q.question,
              options: q.options.map((o) => o.label),
              multi: q.multi ?? false,
              selectedOptions: [],
              customInput: trimmed,
            };
            if (isMultiQ && qIdx < questions.length - 1) {
              loadQuestion(qIdx + 1);
            } else {
              finalize();
              return;
            }
          }
          refresh();
        };

        // ── Input handling ────────────────────────────────────────────────────

        function handleInput(data: string) {
          // Route all keys to editor when in edit mode
          if (editMode) {
            if (matchesKey(data, Key.escape)) {
              editMode = false;
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const q = questions[qIdx];
          const isMulti = q.multi ?? false;
          const rawLabels = q.options.map((o) => o.label);
          const opts = getOptions(qIdx);

          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(opts.length - 1, optionIndex + 1);
            refresh();
            return;
          }

          // Left/right navigation between questions
          if (isMultiQ) {
            if (matchesKey(data, Key.left)) {
              if (qIdx > 0) {
                saveQuestion(qIdx);
                loadQuestion(qIdx - 1);
                refresh();
              }
              return;
            }
            if (matchesKey(data, Key.right)) {
              saveQuestion(qIdx);
              if (qIdx < questions.length - 1) {
                loadQuestion(qIdx + 1);
                refresh();
              } else {
                finalize(); // right arrow on last question = submit
              }
              return;
            }
          }

          if (matchesKey(data, Key.enter)) {
            const choice = opts[optionIndex];

            if (isMulti) {
              if (choice === DONE_LABEL) {
                // Single-question multi-select: explicit submit
                saveQuestion(qIdx);
                finalize();
                return;
              }
              if (choice === OTHER_LABEL) {
                editMode = true;
                refresh();
                return;
              }
              // Toggle checkbox (optionIndex aligns with rawLabels for checkbox rows)
              const rawLabel = rawLabels[optionIndex];
              if (rawLabel !== undefined) {
                const sel = getMultiSet(qIdx);
                if (sel.has(rawLabel)) sel.delete(rawLabel);
                else sel.add(rawLabel);
                refresh();
              }
              return;
            }

            // Single-select
            if (choice === OTHER_LABEL) {
              editMode = true;
              refresh();
              return;
            }
            const selected = stripRecommended(choice);
            saved[qIdx] = {
              id: q.id,
              question: q.question,
              options: rawLabels,
              multi: false,
              selectedOptions: [selected],
            };
            if (isMultiQ && qIdx < questions.length - 1) {
              loadQuestion(qIdx + 1);
              refresh();
            } else {
              finalize();
            }
            return;
          }

          if (matchesKey(data, Key.escape)) {
            done({ results: [], cancelled: true });
          }
        }

        // ── Render ────────────────────────────────────────────────────────────

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;

          const q = questions[qIdx];
          const isMulti = q.multi ?? false;
          const opts = getOptions(qIdx);
          const multiSel = getMultiSet(qIdx);

          const lines: string[] = [];
          const add = (s: string) => lines.push(truncateToWidth(s, width));

          add(theme.fg("accent", "─".repeat(width)));

          // Question text + progress indicator
          const progress = isMultiQ ? theme.fg("dim", ` (${qIdx + 1}/${questions.length})`) : "";
          // Question text — word-wrap long/multi-line questions
          const questionStyled = theme.fg("text", q.question);
          const wrappedQuestion = wrapTextWithAnsi(questionStyled, width - 1);
          for (let wi = 0; wi < wrappedQuestion.length; wi++) {
            const suffix = wi === 0 ? progress : "";
            add(` ${wrappedQuestion[wi]}${suffix}`);
          }
          lines.push("");

          for (let i = 0; i < opts.length; i++) {
            const opt = opts[i];
            const isCursor = i === optionIndex;
            const prefix = isCursor ? theme.fg("accent", "> ") : "  ";

            const isDone = isMulti && opt === DONE_LABEL;
            const isOther = opt === OTHER_LABEL;

            if (isOther && editMode) {
              add(`${prefix}${theme.fg("accent", `${opt} ✎`)}`);
            } else if (isDone) {
              // Dim "Done" until at least one item is selected
              const color = multiSel.size > 0 ? "success" : "dim";
              add(`${prefix}${theme.fg(isCursor ? "accent" : color, opt)}`);
            } else if (isCursor) {
              add(`${prefix}${theme.fg("accent", opt)}`);
            } else {
              add(`  ${theme.fg("text", opt)}`);
            }
          }

          if (editMode) {
            lines.push("");
            add(theme.fg("muted", " Your answer:"));
            for (const line of editor.render(width - 2)) {
              add(` ${line}`);
            }
          }

          lines.push("");
          let helpText: string;
          if (editMode) {
            helpText = " Enter to submit • Esc to go back";
          } else if (isMultiQ) {
            helpText = " ↑↓ navigate • Enter select • ←/→ prev/next • Esc cancel";
          } else {
            helpText = " ↑↓ navigate • Enter select • Esc cancel";
          }
          add(theme.fg("dim", helpText));
          add(theme.fg("accent", "─".repeat(width)));

          cachedLines = lines;
          return lines;
        }

        loadQuestion(0);

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
          content: [{ type: "text", text: "Ask tool was cancelled by the user" }],
          details: {} as AskDetails,
        };
      }

      const { results } = outcome;

      // ── Single-question response ──────────────────────────────────────────
      if (questions.length === 1) {
        const r = results[0];
        const parts: string[] = [];
        if (r.selectedOptions.length > 0) {
          parts.push(
            r.multi
              ? `User selected: ${r.selectedOptions.join(", ")}`
              : `User selected: ${r.selectedOptions[0]}`,
          );
        }
        if (r.customInput !== undefined) {
          parts.push(`User provided custom input: ${r.customInput}`);
        }
        return {
          content: [{ type: "text", text: parts.join("\n") || "User did not select an option" }],
          details: {
            question: r.question,
            options: r.options,
            multi: r.multi,
            selectedOptions: r.selectedOptions,
            customInput: r.customInput,
          } as AskDetails,
        };
      }

      // ── Multi-question response ───────────────────────────────────────────
      const lines = results.map((r) => {
        if (r.customInput !== undefined) return `${r.id}: "${r.customInput}"`;
        if (r.selectedOptions.length > 0) {
          return r.multi
            ? `${r.id}: [${r.selectedOptions.join(", ")}]`
            : `${r.id}: ${r.selectedOptions[0]}`;
        }
        return `${r.id}: (skipped)`;
      });

      return {
        content: [{ type: "text", text: `User answers:\n${lines.join("\n")}` }],
        details: { results } as AskDetails,
      };
    },

    // ─── renderCall ──────────────────────────────────────────────────────────

    renderCall(args, theme, _context) {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      let text = theme.fg("toolTitle", theme.bold("ask "));

      if (questions.length === 1) {
        const q = questions[0];
        text += theme.fg("muted", q.question ?? "");
        const opts = Array.isArray(q.options) ? q.options : [];
        if (q.multi) text += theme.fg("dim", " [multi-select]");
        if (opts.length) {
          const labels = opts.map((o: { label: string }) => o.label).join(", ");
          text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
        }
      } else {
        text += theme.fg("muted", `${questions.length} questions`);
        for (const q of questions) {
          const flag = q.multi ? theme.fg("dim", " [multi]") : "";
          text += `\n  ${theme.fg("dim", `[${q.id}]`)} ${theme.fg("text", q.question)}${flag}`;
        }
      }

      return new Text(text, 0, 0);
    },

    // ─── renderResult ────────────────────────────────────────────────────────

    renderResult(result, _options, theme, _context) {
      const d = result.details as AskDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      // Multi-question
      if (d.results) {
        const lines = d.results.map((r) => {
          const hasAnswer = r.selectedOptions.length > 0 || r.customInput !== undefined;
          const icon = hasAnswer ? theme.fg("success", "✓ ") : theme.fg("dim", "- ");
          const id = theme.fg("dim", `[${r.id}] `);
          if (r.customInput !== undefined) {
            return `${icon}${id}${theme.fg("muted", "(wrote) ")}${theme.fg("accent", r.customInput)}`;
          }
          if (r.selectedOptions.length > 0) {
            return `${icon}${id}${theme.fg("accent", r.selectedOptions.join(", "))}`;
          }
          return `${icon}${id}${theme.fg("dim", "(skipped)")}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      }

      // Single question
      if (d.customInput !== undefined) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", d.customInput),
          0,
          0,
        );
      }
      if (d.selectedOptions && d.selectedOptions.length > 0) {
        return new Text(
          theme.fg("success", "✓ ") + theme.fg("accent", d.selectedOptions.join(", ")),
          0,
          0,
        );
      }
      return new Text(theme.fg("warning", "Cancelled"), 0, 0);
    },
  });
}
