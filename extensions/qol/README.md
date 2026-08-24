# qol

Consolidated quality-of-life and UI extension for the Pi harness. It owns the startup header, compact footer, over-limit context compaction guard, GitHub prompt widget, session and exit commands, and built-in `write` presentation.

## Header

The startup header shows a π block mark, Pi version, model, working directory, git branch, resource counts, and condensed keybinding hints. Set `quietStartup: true` in Pi settings so default startup listings do not duplicate this information.

## Footer

The footer uses up to three compact lines for:

- project path, git branch, and session name;
- context usage, model/thinking level, latest token rate, cost, and token totals;
- extension statuses, goal state, and active infrastructure status such as LSP.

QoL owns the single footer slot while preserving the existing bridge contracts:

- `Symbol.for("pi-visuals:footer")` marks footer ownership.
- `Symbol.for("pi-goal:footer")` supplies `{ getIndicator(isIdle) }` from `goal`.
- `Symbol.for("pi-subagents:manager")` supplies optional subagent lifetime cost.

After native retry and auto-compaction processing settles, QoL immediately requests manual compaction if reported context still exceeds the active model's context window. One request may be pending at a time.

## Widget

`prompt-url` detects supported GitHub PR and issue prompts, shows URL metadata above the editor, and derives a session name when no custom name exists. Metadata loads through `gh pr view` or `gh issue view`.

## Commands

- `/session:copy-id` — copy current session ID and session log path through the shared clipboard helper; print the payload when clipboard access fails.
- `/exit` — exit Pi cleanly through `ctx.shutdown()`.

## Hooks

- `session_start` — refresh and install the header, reset the compaction guard, install the footer, and rebuild `prompt-url` from session history.
- `model_select` — reinstall header and footer for current model state.
- `agent_settled` — compact once when still over limit after native processing, unless Pi or queue-steer has queued/released continuation work.
- `before_agent_start` — detect a supported GitHub URL prompt and populate `prompt-url`.
- `session_switch` — rebuild or clear `prompt-url` from switched session history.

## Write Override

The `write` registration preserves Pi's built-in metadata and delegates all five execution arguments unchanged. Its custom renderers show the target path, compact writing/success/error summaries, and exact raw built-in output when expanded.
