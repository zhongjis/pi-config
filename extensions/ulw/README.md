# ulw

Ultrawork mode injection — intensifies agent behavior with a structured execution prompt.

## Upstream

- **Source:** https://github.com/code-yeongyu/oh-my-openagent
- **Adapted:** Pi-native adaptation of upstream `ultrawork/default.md` (Claude) and `ultrawork/gpt.md` (OpenAI), using Pi agents and tools. Code-quality review is orchestrator-owned: inspect the diff against requirements and run applicable checks directly; Taishang is an architecture/debugging consult, never a code-quality reviewer. Loop mechanism removed (Pi handles continuation). Two-phase detection (input → before_agent_start) keeps the prompt out of the user message. Durable notepads use `local://ulw/<goal-slug>.md` session-local storage (requires `session-local`); the default variant appends via `edit`.
- **GPT-specific contract:** Opt-in high rigor retains automatic Xuannv planning, distinct-question parallel research, active-mode delegation, and scoped correction until acceptance. Behavior changes require RED→GREEN evidence; behavior-preserving refactors require GREEN-before/GREEN-after characterization. Verification records baseline failures and unavailable checks without repairing unrelated work. Real-surface QA cleans up its own resources while preserving deliverables. Resumed tasks reuse their notepad, update current-state sections, and append significant findings.

## What It Does

- Detects "ultrawork" or "ulw" keyword in user messages (case-insensitive, word-boundary)
- Preserves the keyword in user text in kuafu mode
- Injects the ultrawork prompt via `before_agent_start` as a displayed context message (`display: true`) rendered through a custom message renderer as a compact one-line activation banner (`[ultrawork] ᕦ(ò_óˇ)ᕤ mode enabled` — `ctrl+o` to expand the full directive)
- Model-adapted: injects the Claude/default variant by default, and the OpenAI/GPT variant when the active model is GPT-family (`isGptModel` from `lib/model-family`) — Claude is the default
- Only triggers in kuafu (build) mode — other modes pass through untouched
- Sanitizes detection: ignores keywords inside code blocks, inline code, `@file` references, and the ultrawork prompt block itself
- Shows a compact inline activation banner in the transcript at the point of activation (via `pi.registerMessageRenderer`) — no global notification and no persistent footer status badge

## Hooks

- `input` — Detect keyword in kuafu mode, preserve user text, set pending flag
- `before_agent_start` — Inject ultrawork prompt as a displayed message; `pi.registerMessageRenderer("ultrawork", ...)` renders it as a compact banner

## Files Worth Reading

- `index.ts` — Keyword detection, mode gating, two-phase injection
- `prompt.ts` — Loader: selects the prompt variant by model family (`getUltraworkPrompt`)
- `prompts/default.md` — Claude / default ultrawork prompt
- `prompts/gpt.md` — OpenAI / GPT ultrawork prompt
