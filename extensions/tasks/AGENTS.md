# tasks

## Overview
Task-tracking extension: task tools, persistent widget, file-backed DAG, process tracking, auto-clear, and planning-handoff cleanup.

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Registration + lifecycle | `src/index.ts`, `src/lifecycle/store-glue.ts` | Tool/RPC wiring and reminders |
| Persistence + DAG | `src/task-store.ts` | CRUD, blockers, locking, migrations |
| Background processes | `src/process-tracker.ts`, `src/task-runner.ts` | `TaskOutput`/`TaskStop` are process-only |
| Planning handoff | `src/bridge/rpc-handlers.ts` | Deletes session-tagged planning tasks |
| Tool definitions | `src/tools/` | Schemas, descriptions, rendering, `/tasks` |
| Settings/widget | `src/tasks-config.ts`, `src/ui/` | Scope, auto-clear, TUI |
| Key regressions | `test/registration.test.ts`, `test/handoff-cleanup.test.ts`, `test/task-runner.test.ts` | Surface, handoff, process behavior |

## Commands
Run from `extensions/tasks/`.

```bash
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Always
- Keep lifecycle/tool text aligned: `pending -> in_progress -> completed`.
- Keep `TaskOutput` and `TaskStop` limited to processes tracked by `ProcessTracker`.
- Preserve task scope, auto-clear delay, blocker edges, locking, and reserved planning provenance.
- Keep `tasks:rpc:clear-planning-tasks` request/reply behavior; cleanup deletes matching planning tasks without external execution RPC.

## Ask First
- Changing default `taskScope` or `autoClearCompleted` semantics.
- Changing on-disk schema, config path, blocker edges, or planning provenance keys.

## Never
- Never add task-owned worker invocation or execution orchestration.
- Never surface internal continuation-reminder text.
- Never break file-locking/shared-list behavior.

## Gotchas
- `src/index.ts` owns runtime wiring; registration changes need `test/registration.test.ts` updates.
- Completed-task auto-clear is intentionally delayed by turns.
- Process stop finalizes task status as `completed`; no distinct stopped/cancelled state exists.

## Local Tweaks

| File | What | Why |
|------|------|-----|
| `index.ts` | Directory re-export entrypoint while package metadata points to `./index.ts`. | Repo smoke/install discovery. |
| `src/index.ts`, `src/bridge/rpc-handlers.ts` | Planning provenance plus `tasks:rpc:clear-planning-tasks`. | Fu Xi plan handoff cleanup. |
| `src/lifecycle/store-glue.ts` | Transient context-hook reminders with local cooldown/stagnation cap. | Avoid stale persisted reminders while preserving cadence. |
| `src/task-runner.ts`, `src/tools/output.ts`, `src/tools/stop.ts` | Process-only `TaskRunner` seam. | Unit-testable output/stop dispatch. |
| `src/tools/rendering.ts`, `src/tools/list.ts`, `src/ui/task-widget.ts` | Shared width-safe tool reports with task-local action/list/get/process parsing plus compact grouped list/widget output. | Scan-friendly TUI while preserving complete model-visible and expanded content. |
| `package.json`, `README.md` | Repo-local package/test wiring and concise docs. | Root dependency/test model; no npm install guidance. |
| `package.json` | `peerDependencies` for pi packages (+typebox) use pnpm `catalog:` | Versions centralized in root `pnpm-workspace.yaml` `catalog:`. Re-apply after upstream sync (upstream ships literal ranges). |

## Child DOX Index
No child `AGENTS.md` files.
