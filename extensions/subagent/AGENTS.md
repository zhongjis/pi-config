# subagent

## Overview
Background/foreground subagent runtime: tool surface, queueing, widget UI, eventbus RPC, resume/steer/worktree support.

Vendored from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) v0.6.3 (commit `7102b3e`). Local additions: background supervision, delegation policy, result recovery, enhanced skill-loader, abort signal forwarding, model label tracking, persistent subagent session JSONL (`SessionManager.create` with custom dir under `~/.pi/agent/subagent-sessions/`; record + notifications expose `sessionFile`).

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Runtime entry / version-guard bootstrap | `src/index.ts` | 59-line shim: factory delegates to `registerSubagentRuntime` |
| Runtime hub: tool + UI wiring, notifications, event emission | `src/lifecycle/supervision.ts` | `registerSubagentRuntime`; large central wiring file (~900 lines) |
| LLM tool definitions | `src/tools/` | `agent.ts`, `get_subagent_result.ts`, `steer_subagent.ts`; `stop_subagent.ts` is a reserved stub |
| Event listeners, `/agents` command, tool renderers | `src/ui-wiring/` | `messages.ts` (pi.on lifecycle), `commands.ts` (`/agents` menu + CRUD), `renderers.ts` |
| Durable background-agent registry | `src/lifecycle/registry-persistence.ts` | `appendEntry` write-through; replayed on `session_start`, survives compaction |
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
- The runtime hub is `src/lifecycle/supervision.ts` (`registerSubagentRuntime`): it owns tool/UI wiring, widget rendering, notifications, and event emission, so many changes fan out from there. `src/index.ts` is only a 59-line bootstrap + symbol version-guard.
- `subagents:ready` is the discovery signal for other extensions; breaking or delaying it causes load-order bugs.
- Read-only agents still consume memory files in read-only mode; write capability is inferred from available tools after explicit allowlist resolution.
- `prompt_mode` is parsed by both `subagent` (this extension) and `modes`. Subagent honors all three values (`replace`/`append`/`system_instructions`); modes coerces non-`append` to `replace` (see `extensions/modes/src/config-loader.ts`). When changing parser semantics in `extensions/lib/agent-frontmatter.ts`, update both consumers.

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
| `src/custom-agents.ts` | Parses shared agent frontmatter (`builtin_tools`, `extension_tools`, delegation fields, nesting, model) via `extensions/lib/agent-frontmatter.ts`; uses `normalizeThinkingLevel` | Shared schema with modes + thinking level compat |
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
| `src/types.ts`, `src/agent-types.ts` | `promptMode` widened to `"replace" \| "append" \| "system_instructions"` | Adds new mode that injects AGENTS.md project context without parent role/mode body bleed |
| `src/agent-runner.ts` | `inheritContextFiles` derives from `promptMode === "system_instructions"` (overridden to false by `isolated: true`); flips `noContextFiles` so pi auto-injects AGENTS.md as `# Project Context` after `systemPromptOverride` | Single-source-of-truth AGENTS.md inheritance for worker subagents (jintong, guangguang, yunu, weizheng) |
| `src/prompts.ts` | Doc comment lists three modes; builder output for `system_instructions` is identical to `replace` (the branch lives in `agent-runner.ts`) | Mode behavior orthogonal to prompt assembly |
| `src/agent-definition-authoring.ts` | Frontmatter template + guidelines describe `system_instructions` mode | User-visible authoring docs |
| `src/agent-runner.ts`, `src/agent-manager.ts`, `src/index.ts`, `test/agent-runner.test.ts`, `test/index.session-context.test.ts` | Subagent sessions use parent-scoped `~/.pi/agent/subagent-sessions/<parent-session-id>/` and persist `sessionFile`/`sessionDir`/parent metadata in records/events | Keeps main `/tree` session list clean while preserving subagent log discoverability |
