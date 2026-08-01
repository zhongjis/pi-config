# tasks

## Overview
Task-tracking extension: a single `Task` tool (op create/update/list/get), persistent widget, file-backed DAG, auto-clear, and planning-handoff cleanup.

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Registration + lifecycle | `src/index.ts`, `src/lifecycle/store-glue.ts` | Tool/RPC wiring and reminders |
| Persistence + DAG | `src/task-store.ts` | CRUD, blockers, locking, migrations |
| Planning handoff | `src/bridge/rpc-handlers.ts` | Deletes session-tagged planning tasks |
| Tool definition | `src/tools/task.ts`, `src/tools/description.ts` | Single `Task` tool: schema, ops, batch create/update |
| Settings/widget | `src/tasks-config.ts`, `src/ui/` | Scope, auto-clear, TUI |
| Key regressions | `test/registration.test.ts`, `test/handoff-cleanup.test.ts`, `test/task-tool.test.ts`, `test/tool-rendering.test.ts` | Surface, handoff, op-dispatch behavior |

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
- Keep the single-tool surface: one `Task` tool with `op` (create/update/list/get); no per-op tools and no task-owned process/execution tools.
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
- `create` is all-or-nothing; `update` is best-effort per item (reports applied/rejected, hard error only when zero applied).

## Local Tweaks

| File | What | Why |
|------|------|-----|
| `index.ts` | Directory re-export entrypoint while package metadata points to `./index.ts`. | Repo smoke/install discovery. |
| `src/index.ts`, `src/bridge/rpc-handlers.ts` | Planning provenance plus `tasks:rpc:clear-planning-tasks`. | Fu Xi plan handoff cleanup. |
| `src/lifecycle/store-glue.ts` | Transient context-hook reminders with local cooldown/stagnation cap. | Avoid stale persisted reminders while preserving cadence. |
| `src/tools/task.ts` | Consolidated `Task` tool (op create/update/list/get) replacing the former six task tools; dead background-process tools removed. | One tool + batch; no process execution seam. |
| `src/tools/rendering.ts`, `src/ui/task-widget.ts` | Shared width-safe tool reports with op-keyed action/list/get parsing plus compact grouped list/widget output. | Scan-friendly TUI while preserving complete model-visible and expanded content. |
| `package.json`, `README.md` | Repo-local package/test wiring and concise docs. | Root dependency/test model; no npm install guidance. |
| `package.json` | `peerDependencies` for pi packages (+typebox) use pnpm `catalog:` | Versions centralized in root `pnpm-workspace.yaml` `catalog:`. Re-apply after upstream sync (upstream ships literal ranges). |

## Child DOX Index
No child `AGENTS.md` files.
