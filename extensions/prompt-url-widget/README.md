# prompt-url-widget

Shows a PR/issue URL widget in the editor border when the session prompt contains GitHub PR or issue URLs.

## What It Does

- Detects GitHub PR URLs (pattern: "You are given one or more GitHub PR URLs: <url>") and issue URLs (pattern: "Analyze GitHub issue(s): <url>") in session prompts
- Displays a bordered widget with the title, author, and URL
- Fetches metadata (title, author) via `gh pr view` / `gh issue view` in the background
- Auto-names the session based on the PR/issue title (e.g., "PR: Fix auth bug (https://...)")
- Rebuilds widget on session start and session switch from history

## Hooks

- `before_agent_start` — Detect PR/issue URL in prompt, show widget, fetch metadata
- `session_start`, `session_switch` — Rebuild widget from session history
