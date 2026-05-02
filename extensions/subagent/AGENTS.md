# subagent

## Overview
Background/foreground subagent runtime: tool surface, queueing, widget UI, eventbus RPC, resume/steer/worktree support.

Vendored from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) v0.6.3 (commit `7102b3e`). Local additions: background supervision, delegation policy, result recovery, enhanced skill-loader, abort signal forwarding, model label tracking.

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Register tools, lifecycle wiring, notifications | `src/index.ts` | Main integration hub |
| Execution / resume / max-turn behavior | `src/agent-runner.ts` | Session creation + graceful wrap-up |
| Queueing / active-state bookkeeping | `src/agent-manager.ts` | Running vs queued agents |
| Cross-extension RPC | `src/cross-extension-rpc.ts` | `ping`, `spawn`, `stop` handlers |
| Agent registry / custom definitions | `src/agent-types.ts`, `src/custom-agents.ts`, `src/default-agents.ts` | Unified registry with embedded defaults |
| Widget / viewer | `src/ui/` | Persistent widget + conversation viewer |
| Isolation / memory / skill loading | `src/worktree.ts`, `src/memory.ts`, `src/skill-loader.ts` | Side systems with user-visible effects |
| Persistent settings | `src/settings.ts` | Dual-scope (global + project) settings persistence |
| Background supervision | `src/background-supervision.ts` | Auto-steer/abort idle agents (local) |
| Delegation policy | `src/delegation-policy.ts` | Allow/deny agent delegation rules (local) |
| Result recovery | `src/result-recovery.ts` | Fallback text extraction (local) |
| Regression coverage | `test/*.test.ts` | Keep behavior changes paired with tests |

## Commands
Run from `extensions/subagent/`.

```bash
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Always
- Keep background-agent UX aligned with tool contract: queue when over concurrency limit; tell callers to supervise with `get_subagent_result`, `steer_subagent`, and `resume`.
- Keep lifecycle broadcasts on `subagents:*`; keep RPC on `subagents:rpc:*` with replies on `:reply:${requestId}`.
- Use the standard reply envelope everywhere: `{ success: true, data? } | { success: false, error: string }`.
- Treat agent frontmatter as authoritative. Loader/default logic may fill omissions, but should not silently override explicit config.
- Preserve case-insensitive agent-type resolution and fuzzy model matching unless changing that behavior intentionally across docs/tests.

## Ask First
- Changing `subagents:*` payload shape, RPC method names, or reply envelope fields.
- Changing transcript/output-file location semantics or worktree completion behavior.
- Changing notification grouping/join behavior; other flows depend on current completion semantics.

## Never
- Never replace the eventbus RPC bridge with shared mutable globals; `tasks/` integration depends on the RPC contract.
- Never emit unscoped reply channels.
- Never separate lifecycle behavior changes from the tests that lock them down.
- Never assume worktree isolation is guaranteed; fallback-to-main-worktree behavior is part of the current contract.

## Gotchas
- `src/index.ts` is large because it owns tool registration, widget rendering, notifications, and event emission; many changes fan out from there.
- `subagents:ready` is the discovery signal for other extensions; breaking or delaying it causes load-order bugs.
- Read-only agents still consume memory files in read-only mode; write capability is inferred from available tools after explicit allowlist resolution.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `src/background-supervision.ts` | Local-only file | Auto-steer idle agents after timeout, auto-abort after prolonged inactivity |
| `src/delegation-policy.ts` | Local-only file | `allow_delegation_to` / `disallow_delegation_to` / `allow_nesting` enforcement |
| `src/result-recovery.ts` | Local-only file | Fallback text extraction from session history when `record.result` is empty |
| `src/thinking-level.ts` | Local-only file | Normalizes legacy `"none"` → `"off"` for backward compat with existing agent frontmatter |
| `src/types.ts` | Added `allowDelegationTo`, `disallowDelegationTo`, `allowNesting` to `AgentConfig` | delegation-policy.ts reads these fields |
| `src/types.ts` | Kept `modelLabel`, `waitingConsumers`, `isBackground`, `externalAbortCleanup`, `suppressNotification`, `lastSupervisionSteerAt/AbortAt` on `AgentRecord` | Background supervision + abort signal + widget display |
| `src/agent-runner.ts` | `allowNesting` gate on `EXCLUDED_TOOL_NAMES` filter | Permits nested Agent tool when frontmatter opts in |
| `src/agent-manager.ts` | External abort signal forwarding (`bindExternalAbortSignal`), `modelLabel`/`isBackground` on record, `getRecoveredResultText` fallback | Clean cancellation, widget display, non-streaming provider recovery |
| `src/custom-agents.ts` | Parses `allow_delegation_to`, `disallow_delegation_to`, `allow_nesting` from frontmatter; uses `normalizeThinkingLevel` | Delegation policy + thinking level compat |
| `src/invocation-config.ts` | Uses `normalizeThinkingLevel` instead of raw cast | Thinking level compat |
| `src/skill-loader.ts` | Entire file replaced | Pi-aware discovery: SKILL.md dir skills, ancestor `.agents/skills/`, frontmatter name matching, `sourcePath`/`baseDir` metadata |
| `src/prompts.ts` | `skillBlocks` type includes `sourcePath`/`baseDir` | Enhanced skill-loader passes path metadata for relative reference resolution |
| `src/ui/agent-widget.ts` | Kept `lastProgressAt` on `AgentActivity`, `modelLabel` rendering in running/finished lines | Background supervision progress tracking, model display |
| `src/ui/agent-widget.ts`, `src/index.ts`, `src/ui/conversation-viewer.ts`, `test/agent-widget.test.ts`, `README.md` | Nerd Font UI stats: tokens `󰾆 33.8k`, turns `⟳ 5`, tool uses `󱁤 3` | Local display preference; preserve after upstream syncs |
| `src/index.ts` | Background supervision loop + timer, delegation policy enforcement, abort signal binding, result recovery calls, model label tracking, supervision-aware wait, `suppressNotification`/`waitingConsumers` checks | All local features integrated into the main hub |
| `index.ts` | Wrapper re-export (`export default from "./src/index.js"`) | Harness convention: entry at `extensions/<name>/index.ts` |
| `test/background-supervision.test.ts` | Local-only test | Covers supervision logic |
| `test/delegation-policy.test.ts` | Local-only test | Covers delegation allow/deny |
| `test/result-recovery.test.ts` | Local-only test | Covers fallback extraction |
| `test/index.session-context.test.ts` | Local-only test | Covers session context integration |
