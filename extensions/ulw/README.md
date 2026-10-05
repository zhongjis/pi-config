# ulw

Ultrawork mode injection — intensifies agent behavior with a structured execution prompt.

## Upstream

- **Source:** https://github.com/code-yeongyu/oh-my-openagent
- **Adapted:** Pi-native adaptation of upstream `ultrawork/default.md` (Claude) and `ultrawork/gpt.md` (OpenAI), using Pi agents and tools. Pi handles continuation, so there is no loop. Durable notepads use `local://ulw/<goal-slug>.md` (requires `session-local`).

## Local Tweaks

- Both variants selectively vendor uncertainty-sized planning, child GOAL/STOP WHEN/EVIDENCE, and evidence-bounded stopping from upstream [GPT](https://github.com/code-yeongyu/oh-my-openagent/blob/b7a702362ec21ba79c353c4783848ea1d589c5c4/packages/prompts-core/prompts/ultrawork/gpt.md). The test-reading instruction appears in both upstream GPT and [default](https://github.com/code-yeongyu/oh-my-openagent/blob/b7a702362ec21ba79c353c4783848ea1d589c5c4/packages/prompts-core/prompts/ultrawork/default.md).
- Pi uses advisory xuannv planning under active-mode policy, evidence-checked workers, and orchestrator-owned acceptance. Stopping preserves required verification, manual QA, and approval/handoff gates.
- Inline coverage-driven testing policies in [default](prompts/default.md#testing-policy) and [GPT](prompts/gpt.md#testing-policy) consider happy-path, boundary/failure, and adjacent-caller risks without scenario quotas; checks must sufficiently cover affected contracts and coupling. Refactors compare relevant baselines with post-change results; missed baselines are recovered in isolation without discarding user/concurrent changes or misrepresenting chronology. Required repository gates, preservation evidence, and manual QA for runnable changed user surfaces remain binding.
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
