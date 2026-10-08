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
- `extensions:` MUST list only extensions that provide the agent's tools or shape them: the bash stack (`better-bash-tool`, `rtk`, `direnv`) for agents with `bash`, `filter-outputs` for every agent with tools, and `profiles` for agents with external research tools. NEVER list the runner-injected `smart-tool-guards`, `session-local`, or `fast`.
- `tools:` MUST start from `+@all`; its built-in line grants only the needed built-in tools, e.g. `-@builtin, +read, +bash` for read-only agents.
- Mode frontmatter, not guide tables, authorizes mode-scoped delegation.
- Custom Subagents MUST use `prompt_mode: system_instructions` to inherit global/project AGENTS.md without parent identity, subject to runtime isolation.
- Frontmatter `description` is model-visible routing text; it MUST state the same duty boundary as the prompt body.
- Kua Fu/Hou Tu routing prose MUST remain consistent with callable-agent descriptions.
- Model fallback chains MUST use `cliproxyapi` instead of `openai-codex` for Codex models.

## Work Guidance

- You SHOULD keep routing descriptions specific to worker capability.
- Worker outcomes MUST be `COMPLETED`, `PARTIAL`, or `BLOCKED`; a wrap-up request or exhausted budget before the task's acceptance checks pass yields `PARTIAL` with a last-green anchor. Packet sizing and interruption handling belong to mode prompts and the subagents extension; worker prompts MUST NOT restate them.
- You MUST preserve orchestrator-owned verification and code-quality review; [Jintong's prompt](jintong.md) owns outcome-based test selection and smaller-alternative escalation without weakening mandated acceptance or safety checks.
- Huayan is a read-only screenshot-grounded UI reviewer; Yunu owns fixes and the orchestrator retains browser QA, code-quality review, and acceptance.

## Verification

- You MUST use the frontmatter guide's verification checklist after definition edits.
- Agent definition loading coverage: `pnpm exec vitest run --project unit extensions/subagents/test/tool-scope-golden.test.ts`.

## Child DOX Index

- None; this document owns all definitions and remaining files here.
