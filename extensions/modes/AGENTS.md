## Purpose

Construct mode-specific runtime behavior and manage planning approval/handoff.

## Ownership

- Owns mode selection, prompt assembly, model overrides, skill discovery, and planning tools.
- [Mode assets](../../modes/) own persona prompts and mode-owned skills; this runtime consumes them.

## Local Contracts

- Mode prompts MUST retain global AGENTS rules and shared frontmatter semantics.
- Replacement MUST strip prior mode bodies; append mode stacks them.
- `system_instructions` prompt mode is coerced to replacement here.
- Session model overrides MUST NOT rewrite mode frontmatter.
- Scaffold creation MUST preserve existing artifacts; destructive reset requires both `reset` and `force`.
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
