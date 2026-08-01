# Tasks

Claude Code-style task tracking with dependency management, persistent widget, and file-backed storage.

## Tool

A single `Task` tool with an `op` discriminator selects the operation.

### `op: "create"`

Batch-create tasks. All-or-nothing (a malformed item fails the whole call). Returns the new IDs so dependencies can be wired in a follow-up `update`.

`tasks: [{ subject, description, activeForm?, metadata? }]`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `activeForm` | string | no | Present continuous form for spinner |
| `metadata` | object | no | Arbitrary key-value pairs |

### `op: "update"`

Batch-update tasks. Best-effort: each item applies independently; the result reports `Updated …` / `Rejected …` per task and is a hard error only when every item is rejected.

`tasks: [{ taskId, status?, subject?, description?, activeForm?, owner?, metadata?, addBlocks?, addBlockedBy? }]`

Status is `pending`, `in_progress`, `completed`, or `deleted`. Dependencies are bidirectional; `deleted` permanently removes a task and its edges.

### `op: "list"`

Lists tasks grouped as Running, Ready, Blocked, then Completed. Ready means `pending`, no owner, and no unsatisfied blockers.

### `op: "get"`

Takes `taskId` and returns full task details including owner, dependencies, and metadata.

## Widget

Shows running, ready, blocked, and completed counts. Running and ready work appear before blocked and completed work when space is limited.

## Commands

`/tasks` — interactive menu: view tasks, create task, clear tasks, settings.

## Settings

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `taskScope` | `memory` / `session` / `project` | `session` | Where tasks persist |
| `autoClearCompleted` | `never` / `on_list_complete` / `on_task_complete` | `on_list_complete` | Remove completed tasks after a turn delay |

Persisted to `.pi/tasks-config.json`. Override scope with `PI_TASKS` (`off`, named list, or file path).

## Storage

- `memory` — in-process only
- `session` — `.pi/tasks/tasks-<sessionId>.json`
- `project` — `.pi/tasks/tasks.json`

On-disk state uses `schemaVersion: 2`. Legacy v1 state migrates on first write inside the advisory lock. Pre-v2 snapshots remain under `~/.pi/tasks.bak-pre-v2-<ts>/`.

## Events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `tasks:rpc:update` | listen | Apply task updates from another extension |
| `tasks:rpc:clear-planning-tasks` | listen | Delete planning tasks tagged for a handoff session |

## Upstream

- **Source:** https://github.com/tintinweb/pi-tasks
- **Version:** 0.5.0
- **Commit:** `30c3452fd1292860482f1afc7908edb76a46f1ed`
- **License:** MIT
- **Adapted:** Directory entrypoint, peer dependency style, root-relative test/lint scripts, planning-handoff cleanup/provenance, compact tool rendering, and consolidation of the task tools into a single `Task` tool (`op: create/update/list/get`) with the dead background-process tools removed.
