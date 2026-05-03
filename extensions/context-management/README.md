# Context Management

Vendored Pi context-management extension combining pi-context save points/checkouts with pi-context-prune summarization and future-context pruning.

## Upstream

- `pi-context` from `https://github.com/ttttmr/pi-context`, version `1.1.3`, commit `1d8bcf280f9c7ea0ee24249cacc9538eaee71a52`, MIT.
- `pi-context-prune` from `https://github.com/championswimmer/pi-context-prune`, version `0.6.3`, commit `fa793225d9bb355c8df9984fe131cfe74eabee6b`, MIT.
- Local target: `extensions/context-management`.

## Tools

### `context_tag`

Creates a named save point on the current session history. Parameters: `name`, optional `target`.

### `context_log`

Shows session history, tags, branch points, summaries, and HEAD. Parameters: optional `limit`, optional `verbose`.

### `context_checkout`

Branches session context to a target tag/id/root with a carryover summary. Parameters: `target`, `message`, optional `backupTag`.

### `context_tree_query`

Retrieves original pruned tool outputs from the prune index. Supports querying by tool call id or tree browsing helpers.

### `context_prune`

Flushes pending tool-call batches into a summary. Registered always, active only when pruning is enabled with `pruneOn: "agentic-auto"`.

## Commands

- `/acm` — enable agentic context management and inject the context-management skill.
- `/context` — show current context usage dashboard.
- `/pruner` — configure pruning, inspect status/stats/tree, and run on-demand pruning.

## Hooks

- `session_start` / `session_tree` rebuild prune index, stats, frontier, and settings.
- `turn_end`, `tool_execution_end`, `message_end`, `agent_end` capture and flush prune batches according to `pruneOn`.
- `context` removes summarized raw tool results from future LLM context and may add agentic-auto reminders.
- `before_agent_start` injects agentic-auto pruning instructions when enabled.

## Settings / Configuration

Prune settings live at `~/.pi/agent/context-prune/settings.json`.

Fields:

- `enabled` — enables future-context pruning.
- `summarizerModel` — `default` or `provider/model-id`.
- `summarizerThinking` — `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `pruneOn` — `every-turn`, `on-context-tag`, `on-demand`, `agent-message`, `agentic-auto`.
- `remindUnprunedCount` — adds agentic-auto reminders when pending tool calls accumulate.

## Events

No custom cross-extension event family. Uses Pi lifecycle hooks only.

## Local Additions

- Merges two upstream packages into one repo-local extension directory.
- Keeps this repo's existing richer `/context` dashboard while refreshing the rest from upstream.
- Uses repo dependency conventions; no new root package dependencies were added.
- Ships `skills/context-management/SKILL.md` from `pi-context` and `prompts/release.md` from `pi-context-prune` for package metadata completeness.
