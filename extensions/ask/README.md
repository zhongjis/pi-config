# ask

Interactive user prompting tool with multi-question flows, multi-select, recommended options, and free-text "Other" input.

## Upstream

- **Source:** https://github.com/can1357/oh-my-pi
- **Adapted:** Vendored from oh-my-pi's ask tool. Adapted naming (`ask` instead of `question`), added multi-question navigation, recommended option marking.

## What It Does

- Single or multi-question flows with arrow-key navigation
- Checkbox-style multi-select when `multi: true`
- Recommended/default option marking (0-indexed)
- "Other (type your own)" free-text input always available
- Left/right arrow navigation between questions in multi-question mode

## Tools

### `ask`

Ask the user one or more questions during task execution.

**Parameters:**
- `questions` (required): Array of question objects, each with:
  - `id` (required): Unique question identifier
  - `question` (required): Question text to display
  - `options` (required): Array of `{ label }` objects
  - `multi` (optional): Enable checkbox-style multi-selection
  - `recommended` (optional): 0-indexed position of the recommended option

## Hooks

- Emits `user-prompted` event when the ask UI is shown (signals blocking user prompt to other extensions).
