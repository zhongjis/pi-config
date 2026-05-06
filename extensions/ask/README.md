# ask

Interactive user prompting tool. Tab-bar UI for one or more questions, with single- or multi-select options, an optional inline "Other" free-text editor, recommended-option hints, and a final Submit tab.

## Source / Lineage

Restructured 2026 — based on `questionnaire.ts` from the [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts) coding-agent examples (tab-bar layout, Submit-tab pattern, render-loop structure, `Answer`-shaped detail), with the following features merged in from the prior oh-my-pi-derived implementation and from `question.ts` in the same examples folder:

- multi-select per question (`☑/☐` rows, Space toggles, Enter advances)
- `recommended` cursor pre-position with `(Recommended)` suffix (cursor-only; never pre-checks in multi mode)
- word-wrap for prompt text and option descriptions via `wrapTextWithAnsi`
- `pi.events.emit("user-prompted", { tool: "ask" })` event emission per repo conventions
- `Other (type your own)` inline editor row, with mutual exclusion against selected options per question
- empty-questions / empty-options runtime guard (donated from `question.ts`)
- per-question cursor restoration (`lastCursorIndex` per `id`) when the user revisits a tab

Schema is intentionally a clean break from earlier `{ question, options: [{ label }] }` form: options now require `value` + `label` and questions use `prompt` (not `question`).

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

## Tools

### `ask`

Ask the user one or more questions during task execution.

**Parameters:**

- `questions` (required): non-empty array of question objects, each with:
  - `id` (required): unique identifier
  - `prompt` (required): question text shown to the user
  - `options` (required): non-empty array of `{ value, label, description? }`
    - `value` is fed back to the agent
    - `label` is shown to the user
    - `description` shows as a muted secondary line under the label
  - `label` (optional): short tab-bar label (default `Q1`, `Q2`, …); truncated to 12 chars + `…` if longer
  - `allowOther` (optional, default `true`): show the "Other (type your own)" row
  - `multi` (optional, default `false`): allow checkbox-style multi-select
  - `recommended` (optional): 0-indexed cursor pre-position; appends `(Recommended)` to that option; in multi mode it positions the cursor only, it does not pre-check the option

**Result `details` shape:**

```ts
{
  questions: <input questions array>,
  answers: Array<{
    id: string,
    multi: boolean,
    wasCustom: boolean,
    values: string[],   // empty if wasCustom
    labels: string[],   // empty if wasCustom
    indices?: number[], // 1-based, present unless wasCustom
    customInput?: string,
  }>,
  cancelled: boolean,
}
```

**LLM-facing text output:**

- Single-select: `<tabLabel>: user selected: <i>. <displayValue>`
- Multi-select: `<tabLabel>: user selected: 1. <v1>, 3. <v3>`
- Custom: `<tabLabel>: user wrote: <text>`
- Cancelled: `User cancelled the questions.`

`<displayValue>` is `value` when `value !== label`, else `label`.

## Hooks

- Emits `user-prompted` (`{ tool: "ask" }`) once per execution before the blocking UI is shown — see [`extensions/CONVENTIONS.md`](../CONVENTIONS.md). Used by `task-continuation-reminder` to suppress same-run automatic follow-ups while the user is answering.
