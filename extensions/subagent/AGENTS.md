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
- Read-only agents still consume memory files in read-only mode; write capability is inferred from available tools after denylist handling.
