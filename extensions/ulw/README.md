# ulw

Ultrawork mode injection — intensifies agent behavior with a structured execution prompt.

## Upstream

- **Source:** https://github.com/code-yeongyu/oh-my-openagent
- **Adapted:** Pi-native adaptation of upstream `ultrawork/default.md` (Claude) and `ultrawork/gpt.md` (OpenAI), using Pi agents and tools. Pi handles continuation, so there is no loop. Both variants keep a light notepad at `local://ulw/<goal-slug>.md` (requires `session-local`).

## Local Tweaks

- Both variants copy upstream [GPT](https://github.com/code-yeongyu/oh-my-openagent/blob/b7a702362ec21ba79c353c4783848ea1d589c5c4/packages/prompts-core/prompts/ultrawork/gpt.md) wording for scenario sizing, the WHEN TO STOP line, test decisions, the manual-QA table, and stop rules. They share behavior; [default](prompts/default.md) is canonical and [GPT](prompts/gpt.md) restates it in GPT style.
- Both variants add only what the Kua Fu body lacks; delegation, packets, verification, and output rules live in [mode.md](../../modes/kuafu/mode.md) and [gpt.md](../../modes/kuafu/gpt.md). Ultrawork authorizes per-increment commits through `git-master` and runs the [gate-review](../../modes/kuafu/skills/gate-review/SKILL.md) finish gate for larger or riskier changes.
- Notepads use exact-replacement `edit` operations and Agent-tree-shared `local://` storage; requested deliverables retain their required destinations.

## What It Does

- Detects bare `ultrawork` or `ulw` tokens anywhere in user messages (case-insensitive, bounded by whitespace or start/end of input); quoted, path, and punctuation-attached tokens do not activate
- Preserves the keyword in user text in kuafu mode
- Injects the ultrawork prompt via `before_agent_start` as a displayed context message (`display: true`) rendered through a custom message renderer as a compact one-line activation banner (`[ultrawork] ᕦ(ò_óˇ)ᕤ mode enabled` — `ctrl+o` to expand the full directive)
- Model-adapted: injects the Claude/default variant by default, and the OpenAI/GPT variant when the active model is GPT-family (`isGptModel` from `lib/model-family`) — Claude is the default
- Only triggers in kuafu (build) mode — other modes pass through untouched
- Sanitizes detection: ignores keywords inside code blocks, inline code, `@file` references, and the ultrawork prompt block itself
- Shows a compact inline activation banner in the transcript at the point of activation (via `pi.registerMessageRenderer`) — no global notification and no persistent footer status badge

Accepted activation emits `ulw:activated` with the session identity. If [Goal](../goal/README.md) is loaded, it separately enables policy-permitted Goal tools and supplies its hidden task-bootstrap message; ULW never creates Goals itself.

The prompt variants live in [prompts/](prompts/); [index.ts](index.ts) registers the detection hooks and banner renderer.
