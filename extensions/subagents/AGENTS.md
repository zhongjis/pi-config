## Purpose

Run isolated Agent sessions with foreground results and background supervision.

## Ownership

- Owns agent discovery, execution, steering/resume, notifications, and local UI/tests.
- Agent definitions remain outside this runtime; shared utilities belong to [lib](../lib/AGENTS.md).

## Local Contracts

- Fresh descendants MUST inherit the parent's Agent-tree `local://` root, not its conversation by default.
- Terminal sessions remain resumable for 30 minutes in the current parent session; switch, reload, or shutdown may clean them sooner.
- Retention MUST remain bounded; resume is not durable-session availability.
- Rendering changes MUST preserve model-visible completion notifications and tool results.
- Foreground results and background follow-up notifications MUST retain distinct delivery paths.

## Work Guidance

- You MUST preserve upstream execution contracts and [README Local Tweaks](README.md#local-tweaks).
- [README](README.md) owns configuration, supervision, and isolation behavior; NEVER infer disk isolation from transcript settings alone.
- You MUST preserve the [MIT license](LICENSE) and [pinned provenance](README.md#upstream).

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/subagents/test`.
- [Agent manager](test/agent-manager.test.ts) covers retention; [notification rendering](test/notification-rendering.test.ts) covers presentation.
- Root unit selection excludes e2e-named tests; those require separate runtime verification.

## Child DOX Index

- None; this document owns the entire runtime subtree.
