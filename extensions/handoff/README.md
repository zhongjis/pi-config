# handoff

Session handoff system for transferring context to a new focused session.

## What It Does

- Summarizes current session context using a cheap model, then launches a new session with the summary as starting context
- Alternatively writes the summary to a temp-dir handoff document (`/handoff:file`) for handing work to an out-of-session agent
- Supports every canonical mode from the modes extension (kuafu, fuxi, houtu, luban, shennong)
- Optional `--no-summarize` flag skips the summary step
- Integrates with the modes extension for plan-to-execution handoff (`/handoff:start-work`)
- Exports runtime utilities (`buildPlanExecutionGoal`, `registerDirectHandoffBridge`, etc.) for use by other extensions
- Uses an event bus bridge for direct handoff requests between extensions

## Commands

- `/handoff [-mode <mode>] [-no-summarize] <content>` — Transfer context to a new focused session; `-mode` selects its mode
- `/handoff:mode <mode> <content>` — Immediately transfer context to a new session in the selected mode
- `/handoff:file [-no-summarize] [goal]` — Write a handoff document to a temp file (`$TMPDIR/handoff-<timestamp>.md`) for another agent to pick up
- `/handoff:start-work` — Hand off an approved plan to an execution agent in a new session

## Hooks

- `session_shutdown` — Unsubscribe the direct handoff bridge

## Configuration

### Config file

`~/.pi/agent/handoff.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lastSummaryModel` | `string` | `undefined` | Last model used for session summarization |

## Files Worth Reading

- `index.ts` — Command registration and bridge setup
- `config.ts` — Config file I/O
- `runtime.ts` — Core handoff logic: summarization, session creation, bridge protocol
