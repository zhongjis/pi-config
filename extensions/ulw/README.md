# ulw

Ultrawork mode injection — intensifies agent behavior with a structured execution prompt.

## Upstream

- **Source:** https://github.com/code-yeongyu/oh-my-openagent
- **Adapted:** Pi-native adaptation. Replaced omo agent calls with pi agent names (chengfeng/wenchang/taishang/fuxi/jintong). Removed model routing and loop mechanism (pi handles those). Two-phase detection (input → before_agent_start) keeps prompt out of user message.

## What It Does

- Detects "ultrawork" or "ulw" keyword in user messages (case-insensitive, word-boundary)
- Strips the keyword from user text
- Injects the ultrawork prompt via `before_agent_start` as a collapsed context message
- Only activates in kuafu (build) mode — other modes are skipped with a notification
- Sanitizes detection: ignores keywords inside code blocks, inline code, `@file` references, and the ultrawork prompt block itself
- Shows "⚡ Ultrawork Mode Activated" notification and status bar indicator

## Hooks

- `input` — Detect keyword, strip from text, set pending flag
- `before_agent_start` — Inject ultrawork prompt as collapsed message

## Files Worth Reading

- `index.ts` — Keyword detection, mode gating, two-phase injection
- `prompt.ts` — The ultrawork prompt content
