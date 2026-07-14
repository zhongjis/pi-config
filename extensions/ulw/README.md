# ulw

Ultrawork mode injection — intensifies agent behavior with a structured execution prompt.

## Upstream

- **Source:** https://github.com/code-yeongyu/oh-my-openagent
- **Adapted:** Pi-native adaptation. Replaced omo agent calls with pi agent names (chengfeng/wenchang/taishang/fuxi/jintong/juling/yunu/guangguang) and pi tools (`Agent`/`get_subagent_result`/`steer_subagent`, `codegraph_*`, `rg`/`read`/`fd`/`lsp`). Code-quality review uses an `orchestrator-owned code-quality gate`: the orchestrator inspects the diff against requirements and runs applicable checks directly; Taishang remains architecture/debugging consult and F1 plan-compliance only, never code-quality reviewer. Two prompt variants are adapted faithfully from upstream `ultrawork/default.md` (Claude) and `ultrawork/gpt.md` (OpenAI). Loop mechanism removed (pi handles continuation). Two-phase detection (input → before_agent_start) keeps prompt out of user message.

## What It Does

- Detects "ultrawork" or "ulw" keyword in user messages (case-insensitive, word-boundary)
- Preserves the keyword in user text in kuafu mode
- Injects the ultrawork prompt via `before_agent_start` as a collapsed context message
- Model-adapted: injects the Claude/default variant by default, and the OpenAI/GPT variant when the active model is GPT-family (`isGptModel` from `lib/model-family`) — Claude is the default
- Only triggers in kuafu (build) mode — other modes pass through untouched
- Sanitizes detection: ignores keywords inside code blocks, inline code, `@file` references, and the ultrawork prompt block itself
- Shows "⚡ Ultrawork Mode Activated" notification and status bar indicator

## Hooks

- `input` — Detect keyword in kuafu mode, preserve user text, set pending flag
- `before_agent_start` — Inject ultrawork prompt as collapsed message

## Files Worth Reading

- `index.ts` — Keyword detection, mode gating, two-phase injection
- `prompt.ts` — Loader: selects the prompt variant by model family (`getUltraworkPrompt`)
- `prompts/default.md` — Claude / default ultrawork prompt
- `prompts/gpt.md` — OpenAI / GPT ultrawork prompt
