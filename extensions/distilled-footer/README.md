# distilled-footer

Compact footer replacing the default pi footer with essential session info.

## What It Does

**Line 1:** Project directory (basename if git, full path otherwise) · git branch · session name (if set)

**Line 2:** Context usage % / window size · model ID / thinking level · tok/s (last message) · cost (with subscription indicator) · token I/O counts (labeled: in/out/cache) aligned right

**Line 3 (conditional):** Extension statuses on left, infrastructure statuses (MCP, LSP) on right.

- Color-coded context usage (green/yellow/red by percentage)
- Color-coded cost ($10+ red, $1+ yellow)
- Aggregates token usage from all assistant messages in the session
- Reinstalls on model changes to keep model line current
- Priority-ordered segment dropping when line 2 overflows: ctx > model > tok/s > cost
- tok/s reflects the most recent assistant message: `output_tokens / (msg.timestamp - prev_msg.timestamp)`. Hidden when no valid sample (errored, aborted, or <250ms duration).

## On Exit

When the user quits (Ctrl+C, Ctrl+D, `/quit`, SIGHUP, SIGTERM), prints:

```
Continue the session with: pi --session <session-id>
```

Skipped for internal session transitions (reload, new, resume, fork).

## Hidden Statuses

These status keys are filtered out of line 3 to reduce noise:

- `thinking-steps` — duplicates thinking level shown on line 2
- `caveman` — user-opt-in indicator; not footer-worthy

Decorative leading glyphs (●, ○, •, etc.) are stripped from `agent-mode` and `clauderock` status text.

## Hooks

- `session_start`, `model_select` — Install/reinstall the footer
- `session_shutdown` — Print continuation hint on user-initiated exits
