# ask

Interactive user prompting tool. Tab-bar UI for one or more questions, with single- or multi-select options, an optional inline "Other" free-text editor, recommended-option hints, and a final Submit tab.

## Source

Based on `questionnaire.ts` from the [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts) coding-agent examples (tab-bar layout, Submit-tab pattern, render-loop structure), with multi-select, recommended-option hints, word-wrap, the inline "Other" editor, empty-input guards, and per-question cursor restoration added locally. Some features come from `question.ts` in the same examples folder.

## What It Does

- One or more questions in a tab bar (`Q1 / Q2 / … / Submit`); single questions with single-select skip the Submit tab and finalize on pick.
- Tab cells show `■` answered / `□` unanswered, live-updating per toggle.
- Tab navigation: `Tab` / `Shift+Tab` and `←` / `→` cycle.
- Within a question:
  - `↑` / `↓` move between options (and the "Other" pseudo-row).
  - Single-select `Enter`: pick + auto-advance to next tab (or Submit if last).
  - Multi-select `Space`: toggle option. Multi-select `Enter`: advance.
  - "Other" `Enter`: opens inline editor; submit replaces the selection for that question.
  - Choosing "Other" clears any toggled options for that question; toggling any option clears a prior custom input. Custom is "all or nothing" within a question.
- Submit tab shows the formatted answer for each question and warns about unanswered ones; `Enter` submits when complete.
- `Esc` cancels at any tab.

## Entry Points

- `ask` tool — ask the user one or more questions during task execution. Each question has an `id`, a `prompt`, and `options` of `{ value, label, description? }`; `value` is returned to the agent and `label` is shown to the user. The parameter schema is registered in [`index.ts`](index.ts); result `details` types live in [`types.ts`](types.ts).
- Agent-facing answer text (`<tabLabel>: user selected: …`, `<tabLabel>: user wrote: …`, or `User cancelled the questions.`) is formatted in [`format.ts`](format.ts).

## Events

- Emits `user-prompted` (`{ tool: "ask" }`) once per execution before the blocking UI is shown — see [`extensions/CONVENTIONS.md`](../CONVENTIONS.md). Used by `task-continuation-reminder` to suppress same-run automatic follow-ups while the user is answering.
