# copy-session-id

Copies the current session ID and log file path to the clipboard.

## What It Does

- Formats session metadata (session ID + log path) in a structured format suitable for the `pi-jsonl-logs` skill
- Copies to clipboard using the shared `../lib/clipboard.js` utility
- Falls back to console output if clipboard copy fails

## Commands

- `/session:copy-id` — Copy current session ID and session log path to clipboard
