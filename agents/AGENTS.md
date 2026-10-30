## Purpose

Callable Subagent definitions and their bounded delegation contracts.

## Ownership

- This document owns all agent definitions in this directory.
- Mode Agent prompts belong to [../modes/](../modes/).
- Runtime loading and enforcement belong to [../extensions/subagents/](../extensions/subagents/).

## Local Contracts

- You MUST follow the [frontmatter guide](../docs/guides/agent-frontmatter.md).
- A definition is either flat `<name>.md` (default body only) or directory `<name>/default.md` (frontmatter and default body) with optional body-only `gpt.md` (replacement) and `gemini.md` (overlay), selected per run from the child's model family as [modes](../modes/README.md) do. Other files in an agent directory are ignored.
- [Subagents custom agents](../extensions/subagents/README.md#custom-agents) owns the per-name definition loading order and fallback warnings.
- You MUST preserve role boundaries in the [orchestration guide](../docs/guides/agent-orchestration.md).
- You MUST align tool allowlists with each agent's stated role.
- Implementation workers MUST remain non-delegating; they investigate with their own tools and return unresolved research needs to the orchestrator.
- Read-only consultants MUST NOT receive mutating tools; bash requires runtime guarding.
- `delegation` on a Subagent enables only `delegate_research`; its `+` rules MUST name read-only research Subagents; rules that resolve to none disable nesting and warn the user ([ADR 0007](../docs/adr/0007-nested-research-through-a-root-manager-bridge.md)).
- `extensions:` MUST list only extensions that provide the agent's tools or shape them: the bash stack (`better-bash-tool`, `rtk`, `direnv`) for agents with `bash`, `filter-outputs` for every agent with tools, and `profiles` for agents with external research tools. NEVER list the runner-injected `smart-tool-guards`, `session-local`, or `fast`.
- `tools:` MUST start from `+@all`; its built-in line grants only the needed built-in tools, e.g. `-@builtin, +read, +bash` for read-only agents.
- Mode frontmatter, not guide tables, authorizes mode-scoped delegation.
- Custom Subagents MUST use `prompt_mode: system_instructions` to inherit global/project AGENTS.md without parent identity, subject to runtime isolation.
- Frontmatter `description` is model-visible routing text; it MUST state the same duty boundary as the prompt body.
- Kua Fu/Hou Tu routing prose MUST remain consistent with callable-agent descriptions.
- Model fallback chains MUST use `cliproxyapi` instead of `openai-codex` for Codex models.

## Work Guidance

- Implementation workers [Guangguang](guangguang/default.md), [Jintong](jintong/default.md), [Juling](juling/default.md), and [Yunu](yunu/default.md) use directory definitions: `default.md` owns frontmatter and the Claude/default body; body-only `gpt.md` is independently authored against the same contracts, not a mechanical translation. Preserve each worker's routing, workflow, and exact report format across both families.
- Shared worker contracts cover refusal, verification, termination, and style: denials remain final for the worker and parent; completion requires acceptance evidence and readback, with unavailable checks disclosed. Reuse valid passing evidence and stop after success; check counts never establish completion.
- You SHOULD keep routing descriptions specific to worker capability.
- [Wenchang](wenchang.md) uses guarded Bash for Lark document search/read and loads the relevant installed Lark skills; keep its Lark instructions limited to that workflow.
- [Taishang](taishang/default.md#research-delegation), [Di Renjie](direnjie.md#research-delegation), [Yanluo](yanluo.md#research-delegation), and [Xuannv](xuannv.md#research-delegation) own inline research routing aligned with [Kua Fu's exploration policy](../modes/kuafu/default.md): delegate unresolved discovery, retain consultant judgment and required personal inspection.
- Preserve [Jintong's general-worker boundary](jintong/default.md) and [Juling's complex-worker boundary](juling/default.md); their prompts own evidence-based routing and implementation duties.
- Worker outcomes MUST be `COMPLETED`, `PARTIAL`, or `BLOCKED`; a wrap-up request or exhausted budget before the task's acceptance checks pass yields `PARTIAL` with a last-green anchor. Packet sizing and orchestration-level interruption handling belong to mode prompts and the subagents extension; workers own their truthful outcome and safe resume anchor.
- You MUST preserve orchestrator-owned verification and final acceptance. Kua Fu's [gate-review](../modes/kuafu/skills/gate-review/SKILL.md) finish gate assigns Spec review to `direnjie` and Standards review to `taishang` through their diff-review paragraphs; both advise and never edit. [Jintong's prompt](jintong/default.md) owns outcome-based test selection and smaller-alternative escalation without weakening mandated acceptance or safety checks.
- Code-writing workers (`jintong`, `juling`, `guangguang`, `yunu`) MUST preload the `programming` skill; test-quality rules live in that skill, not in worker prompts.
- [Yunu](yunu/default.md) owns UI design within the brief, implementation, and bounded rendered self-checks, including its design-skill integration. Workers interpret preserved requests through the loaded skill, retaining explicit actions and pinned decisions rather than a duplicate command router. The orchestrator retains integrated browser QA, code-quality review, acceptance, and required user questions/approvals. [Huayan](huayan.md) provides read-only screenshot-grounded visual review when explicitly requested by the user, disclosing unsupported workflow steps without treating recommendations as implementation authority.

## Verification

- You MUST use the frontmatter guide's verification checklist after definition edits.
- Agent definition loading coverage: `pnpm exec vitest run --project unit extensions/subagents/test/tool-scope-golden.test.ts`.

## Child DOX Index

- None; this document owns all definitions and remaining files here.
