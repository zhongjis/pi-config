# tasks

## Overview
Task-tracking extension: Claude Code-style task tools, persistent widget, file-backed DAG, process tracking, and optional subagent execution.

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Tool definitions, reminder injection, subagent bridge | `src/index.ts` | Central behavior hub |
| Persistence + dependency graph | `src/task-store.ts` | CRUD, blockers, locking |
| Background process handling | `src/process-tracker.ts` | Output buffering + stop flow |
| Task read/stop dispatch (process vs subagent) | `src/task-runner.ts` | `TaskRunner` seam; `TaskOutput`/`TaskStop` route here instead of branching on model |
| Settings persistence | `src/tasks-config.ts` | `.pi/tasks-config.json` contract |
| Auto-clear rules | `src/auto-clear.ts` | Turn-based cleanup logic |
| Widget / settings UI | `src/ui/` | Task list + settings menu |
| RPC/subagent regressions | `test/subagent-integration.test.ts`, `test/handoff-cleanup.test.ts` | High-value safety net |

## Commands
Run from `extensions/tasks/`.

```bash
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Always
- Keep task lifecycle/tool descriptions aligned: `pending -> in_progress -> completed`; if guidance changes, update the tool text and matching tests together.
- Preserve the request/reply RPC contract to `subagents:*`; `TaskExecute`, `TaskOutput`, and `TaskStop` depend on `requestId`-scoped replies plus `agentTaskMap` lookups (read/stop now dispatched behind `src/task-runner.ts`).
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
- Task terminal states collapse to `completed`: `TaskStop` and a stopped subagent both finalize as `completed` — there is no distinct `stopped`/`cancelled` status, so a killed task is indistinguishable from a finished one. `finalizeStop` (`src/task-runner.ts`) is the single seam to add one if ever needed.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Local re-export entrypoint is kept as `export { default } from "./src/index.js";` while package metadata points Pi to `./index.ts`. | Repo smoke/install discovery expects directory entrypoints. |
| `src/index.ts` | Preserves Fu Xi planning provenance metadata helpers and `tasks:rpc:clear-planning-tasks` handler. | Plan-execute handoff cleanup depends on this local RPC surface. |
| `src/index.ts` | `TaskCreate` examples and `agentType` copy mention `chengfeng`/custom local subagents instead of upstream `general-purpose` examples. | Local harness agents are mythology-named; prompts should route to available agent types. |
| `package.json` | Uses peer dependencies for Pi/typebox, root-relative Vitest scripts, `biome --config-path`, and `pi.extensions: ["./index.ts"]`; no package-lock is vendored. | Keeps this vendored package compatible with root dependency management and repo extension loading. |
| `README.md` | Concise repo-local README replaces upstream marketing/install content and documents provenance/local adaptations. | This repo vendors extensions locally and avoids npm install instructions. |
| `test/handoff-cleanup.test.ts` | Local-only regression tests for planning provenance and handoff cleanup. | Protects Fu Xi planning task cleanup behavior. |
| `src/lifecycle/store-glue.ts` | System-reminder delivery matches upstream 0.7.0 (transient `context`-hook injection via `runtime.reminderDue`, never `tool_result` content mutation), but cadence keeps the local `ContinuationCooldown` (backoff + stagnation cap). | Adopts upstream's stale-reminder fix without discarding local backoff/stagnation cadence; do NOT replace with upstream's simpler `reminder-cadence.ts`. |
| `src/task-runner.ts`, `src/tools/output.ts`, `src/tools/stop.ts` | `TaskRunner` seam: process + subagent execution sit behind one interface as adapters; `TaskOutput`/`TaskStop` call the runner instead of branching on model and re-walking `agentTaskMap` inline. Behavior-preserving. | Deepening refactor — removes the per-tool model fork + duplicated id-resolution; makes the read/stop paths unit-testable with a fake bridge (`test/task-runner.test.ts`). Not in upstream. |
| `src/tools/rendering.ts`, `src/tools/list.ts`, `src/tools/execute.ts`, `src/ui/task-widget.ts`, `test/tool-rendering.test.ts`, `test/task-widget.test.ts`, `test/subagent-integration.test.ts` | Task tools share compact TUI renderers: `renderCall` owns the header, collapsed `renderResult` emits short `keyword: content` summaries only (no trailing expand-hint line; the terminal line uses `└─` and ctrl+o still expands), expanded output returns raw `content`. `TaskList` raw/collapsed output groups Running/Ready/Blocked/Completed; the widget surfaces running/ready/blocked/done counts and keeps active/ready tasks before completed overflow; `TaskExecute` adds a soft `Also ready:` tip when other executable ready tasks were not requested. | Preserves model-visible task tool output while keeping human-facing collapsed results and widget state glanceable; encourages safe batching without changing `autoCascade` defaults or enforcing parallel execution. |

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/tasks/`.
