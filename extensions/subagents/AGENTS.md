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
- Run reports MUST derive model/thinking from SDK session getters, including inherited models and clamping/off.
- Queued/pre-session reports NEVER present requested model/thinking as actual execution.
- Omitted thinking MUST use SDK selected-model defaults, NEVER parent thinking.
- `thinkingDefault` MUST track configuration intent only; unknown intent stays unlabelled.
- `thinking: default (pending)` MUST survive queued retrieval until session metadata replaces it; resume retains session thinking.
- Foreground, retrieval, and resume MUST share structured result/error, transcript, and diagnostic details.
- Compact run results MUST fit three physical rows including the configured expand hint; expanded reports retain complete answer/error before metadata and artifacts.
- Runtime diagnostics MUST remain visible expanded without counting as tool executions; expanded Run MUST explicitly show zero tools.
- Legacy/malformed details MUST retain full raw content expanded and obey the compact row budget.
- Runtime metadata MUST preserve non-runtime invocation tags; resume turns MUST count `turn_end`, not usage messages.
- Configured model chains MUST fail when exhausted; only absent model configuration inherits the parent.
- Final answers at the soft turn limit MUST complete normally; unfinished tool turns receive wrap-up steering.

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
