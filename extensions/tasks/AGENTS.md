# tasks

## Overview
Task-tracking extension: Claude Code-style task tools, persistent widget, file-backed DAG, process tracking, and optional subagent execution.

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Tool definitions, reminder injection, subagent bridge | `src/index.ts` | Central behavior hub |
| Persistence + dependency graph | `src/task-store.ts` | CRUD, blockers, locking |
| Background process handling | `src/process-tracker.ts` | Output buffering + stop flow |
| Settings persistence | `src/tasks-config.ts` | `.pi/tasks-config.json` contract |
| Auto-clear rules | `src/auto-clear.ts` | Turn-based cleanup logic |
| Widget / settings UI | `src/ui/` | Task list + settings menu |
| RPC/subagent regressions | `test/subagent-integration.test.ts`, `test/handoff-cleanup.test.ts` | High-value safety net |

## Commands
Run from `extensions/tasks/`.

```bash
npm run test
npm run typecheck
npm run lint
npm run build
```

## Always
- Keep task lifecycle/tool descriptions aligned: `pending -> in_progress -> completed`; if guidance changes, update the tool text and matching tests together.
- Preserve the request/reply RPC contract to `subagents:*`; `TaskExecute`, `TaskOutput`, and `TaskStop` depend on `requestId`-scoped replies plus `agentTaskMap` lookups.
- Keep standalone mode working when `subagent` is absent; only `TaskExecute` should degrade.
- Treat storage location as behavior, not implementation detail: session tasks live under `.pi/tasks/`, shared config under `.pi/tasks-config.json`.
- Preserve reserved provenance handling for planning-mode metadata merges.

## Ask First
- Changing default `taskScope`, `autoCascade`, or `autoClearCompleted` semantics.
- Changing on-disk task schema, config path, or blocker edge behavior.
- Changing how subagent completion/failure maps back to task status.

## Never
- Never tell a `TaskExecute`-launched agent to spawn duplicate `Agent` work; that guidance is deliberate and tested.
- Never surface the internal continuation-reminder text to the user.
- Never break file-locking/shared-list behavior when touching persistence.
- Never change subagent-RPC behavior without updating `test/subagent-integration.test.ts` and `test/handoff-cleanup.test.ts`.

## Gotchas
- `src/index.ts` mixes user-facing tool specs with runtime wiring; text-only edits can change agent behavior materially.
- Completed-task auto-clear is intentionally delayed by turns for UX; immediate cleanup is usually a regression here.
- A stopped subagent is not treated the same as a hard failure; status mapping is subtle and covered by tests.
