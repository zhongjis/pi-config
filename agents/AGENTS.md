## Purpose

Callable Subagent definitions and their bounded delegation contracts.

## Ownership

- This document owns all agent definitions in this directory.
- Mode Agent prompts belong to [../modes/](../modes/).
- Runtime loading and enforcement belong to [../extensions/subagents/](../extensions/subagents/).

## Local Contracts

- You MUST follow the [frontmatter guide](../docs/guides/agent-frontmatter.md).
- You MUST preserve role boundaries in the [orchestration guide](../docs/guides/agent-orchestration.md).
- You MUST align tool allowlists with each agent's stated role.
- Read-only consultants MUST NOT receive mutating tools; bash requires runtime guarding.
- `allow_nesting` on a Subagent enables only `delegate_research`; its `allow_delegation_to` MUST list read-only research Subagents ([ADR 0007](../docs/adr/0007-nested-research-through-a-root-manager-bridge.md)).
- `extensions:` MUST list only extensions that provide the agent's tools or shape them: the bash stack (`better-bash-tool`, `rtk`, `direnv`) for agents with `bash`, `filter-outputs` for every agent with tools, and `profiles` for agents with external research tools. NEVER list the runner-injected `smart-tool-guards`, `session-local`, or `fast`.
- `tools:` MUST start from `+@all`; its built-in line grants only the needed built-in tools, e.g. `-@builtin, +read, +bash` for read-only agents.
- Mode frontmatter, not guide tables, authorizes mode-scoped delegation.
- Custom Subagents MUST use `prompt_mode: system_instructions` to inherit global/project AGENTS.md without parent identity, subject to runtime isolation.
- Frontmatter `description` is model-visible routing text; it MUST state the same duty boundary as the prompt body.
- Kua Fu/Hou Tu routing prose MUST remain consistent with callable-agent descriptions.
- Model fallback chains MUST use `cliproxyapi` instead of `openai-codex` for Codex models.

## Work Guidance

- You SHOULD keep routing descriptions specific to worker capability.
- [Wenchang](wenchang.md) uses guarded Bash for Lark document search/read and loads the relevant installed Lark skills; keep its Lark instructions limited to that workflow.
- [Taishang](taishang.md#research-delegation), [Di Renjie](direnjie.md#research-delegation), [Yanluo](yanluo.md#research-delegation), and [Xuannv](xuannv.md#research-delegation) own inline research routing aligned with [Kua Fu's exploration policy](../modes/kuafu/mode.md): delegate unresolved discovery, retain consultant judgment and required personal inspection.
- Preserve [Jintong's general-worker boundary](jintong.md) and [Juling's complex-worker boundary](juling.md); their prompts own evidence-based routing and implementation duties.
- Worker outcomes MUST be `COMPLETED`, `PARTIAL`, or `BLOCKED`; a wrap-up request or exhausted budget before the task's acceptance checks pass yields `PARTIAL` with a last-green anchor. Packet sizing and interruption handling belong to mode prompts and the subagents extension; worker prompts MUST NOT restate them.
- You MUST preserve orchestrator-owned verification and final acceptance. Kua Fu's [gate-review](../modes/kuafu/skills/gate-review/SKILL.md) finish gate assigns Spec review to `direnjie` and Standards review to `taishang` through their diff-review paragraphs; both advise and never edit. [Jintong's prompt](jintong.md) owns outcome-based test selection and smaller-alternative escalation without weakening mandated acceptance or safety checks.
- [Yunu](yunu.md) owns UI design within the brief, implementation, and bounded rendered self-checks, including its design-skill integration. Workers interpret preserved requests through the loaded skill, retaining explicit actions and pinned decisions rather than a duplicate command router. The orchestrator retains integrated browser QA, code-quality review, acceptance, and required user questions/approvals. [Huayan](huayan.md) provides read-only screenshot-grounded visual review when explicitly requested by the user, disclosing unsupported workflow steps without treating recommendations as implementation authority.

## Verification

- You MUST use the frontmatter guide's verification checklist after definition edits.
- Agent definition loading coverage: `pnpm exec vitest run --project unit extensions/subagents/test/tool-scope-golden.test.ts`.

## Child DOX Index

- None; this document owns all definitions and remaining files here.
