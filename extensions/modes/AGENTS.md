## Purpose

Construct mode-specific runtime behavior and manage planning approval/handoff.

## Ownership

- Owns mode selection, prompt assembly, model overrides, skill discovery, and planning tools.
- [Mode assets](../../modes/) own persona prompts and mode-owned skills; this runtime consumes them.

## Local Contracts

- Only `kuafu`, `fuxi`, and `houtu` are registered, selectable, and cycled modes; aliases remain `build`, `plan`, and `execute`.
- Reject retired or malformed saved modes before restoring associated model override or planning/review state; fall back to clean `kuafu`. Preserve valid saved state and existing CLI precedence, including explicit `kuafu` restoration.

- Mode prompts MUST retain global AGENTS rules and shared frontmatter semantics.
- Replacement MUST strip prior mode bodies; append mode stacks them.
- `system_instructions` prompt mode is coerced to replacement here.
- Session model and effort (thinking-level) overrides MUST NOT rewrite mode frontmatter; they are captured from `/mode-model` and manual mid-session model/effort picks, persist with mode state, and clear via `/mode-model --reset`.
- Runtime quota/rate-limit fallback MUST use the override or active mode chain after native settlement, with the shared lib coordinator; no chain means no recovery. Apply the next candidate's thinking/Fast defaults without replaying the prompt.
- The selected effective model candidate defaults Fast on only with terminal `:fast`; otherwise off. Validate explicit on before applying/committing mode changes; unsupported capability MUST NOT select a fallback.
- Persist defaults/user overrides as branch-local `fast-policy` entries. Actual mode transitions (even same-model) and changed model overrides reset the default; prompts, same-mode selection, and reload MUST preserve `/fast`. Emit `fast:policy-changed` only for session-scoped UI refresh; requests read durable policy.
- Scaffold creation MUST preserve existing artifacts; destructive reset requires both `reset` and `force`.
- Runtime scaffold wave guidance MUST follow [Fu Xi's task-sizing contract](../../modes/fuxi/AGENTS.md), not numeric quotas.
- Approval/review flow MUST precede approved-plan handoff to execution.
- Skill-resource transitions reload the terminal; prompt arguments do not auto-run afterward.

## Work Guidance

- [README](README.md) owns mode aliases, frontmatter, tools, and transition behavior.
- You MUST use the shared frontmatter schema rather than revive obsolete tool keys.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/modes/test`.
- [Hooks](test/hooks.test.ts), [approval](test/plan-approval.test.ts), and [scaffold](test/plan-scaffold.test.ts) cover prompt and planning boundaries.

## Child DOX Index

- None; this document owns runtime source and tests, not the external mode asset tree.
