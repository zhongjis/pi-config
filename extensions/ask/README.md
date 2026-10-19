# ask

Structured user decisions in Pi's interactive TUI, with single/multi-select choices, free text, notes, and option previews.

## Source

The tool's lineage includes [`questionnaire.ts` and `question.ts` from badlogic/pi-mono](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions) for the tabbed questionnaire and editor layout, and [`oh-my-pi`](https://github.com/can1357/oh-my-pi) for the original ask tool. [`pi-ask`](https://github.com/eko24ive/pi-ask) inspires notes, Elaborate, previews, digit shortcuts, and the dismiss guard.

## What It Does

- Questions support recommended choices, advisory required markers, and an optional free-text answer. Multi-select answers can combine options and free text.
- Answer and note [editors](dialog.ts) offer `@` file-path and `$skill:` skill-name [completion](autocomplete.ts), using skills available in Pi.
- The [dialog](dialog.ts) shows option previews beside the choices on wide terminals and below them on narrow terminals. Question and option notes stay visible while navigating.
- Review offers Submit, Elaborate, and Cancel. Submit accepts partial answers; unanswered required questions are flagged rather than blocking submission. Elaborate returns the user's notes for clarification while retaining their decisions.
- A single single-select question submits on selection when there are no notes; with notes, it opens Review. Navigation and digit shortcuts use the [key resolver](keys.ts), including configured Pi selection bindings and matching hints.
- Cancelling an editor preserves non-blank text as a draft. Dismissing a dirty dialog requires confirmation; explicit Review cancellation is immediate. An abort closes the dialog once.
- Invalid input returns all [validation issues](normalize.ts) without opening a dialog. Outside interactive TUI mode, the tool returns a question list for asking the user directly.

## Entry Points

Use the `ask` tool when a decision depends on a user preference. [Registration and execution](index.ts) own the tool's agent guidance and integration; the [schema and result types](types.ts) define its input and structured output.

[Result formatting](format.ts) produces answer lines, notes, clarification instructions, and non-TUI question lists.

## Integration

The [execution lifecycle](index.ts) signals user prompting and balances the blocking notification and terminal status when the dialog closes. It runs sequentially so another tool dialog cannot displace it. The shared [event conventions](../CONVENTIONS.md) own integration contracts; the local terminal-status shim is documented beside its implementation.
