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

## Finish nudges

When Pi settles idle after a clean run, a hidden follow-up may remind the agent to finish unresolved local tasks it created or updated in the current user episode. Nudges are bounded, never mutate tasks, and yield to Goal, child agents, pending user or mode actions, and running processes. [src/lifecycle/finish-continuation.ts](src/lifecycle/finish-continuation.ts) defines eligibility and limits.

## Commands

`/tasks` — interactive menu: view tasks, create task, clear tasks, settings.

## Settings

`taskScope` selects `memory`, `session`, or `project` persistence; `autoClearCompleted` controls removal of completed tasks. [src/tasks-config.ts](src/tasks-config.ts) defines keys and defaults.

Persisted to `.pi/tasks-config.json`. Override scope with `PI_TASKS` (`off`, named list, or file path).

## Storage

- `memory` — in-process only
- `session` — `.pi/tasks/tasks-<sessionId>.json`
- `project` — `.pi/tasks/tasks.json`

On-disk state uses `schemaVersion: 2`.

## Events

Other extensions can update tasks and clear handoff planning tasks over the event bus; [src/bridge/rpc-handlers.ts](src/bridge/rpc-handlers.ts) defines the events.

## Upstream

- **Source:** https://github.com/tintinweb/pi-tasks
- **Version:** 0.5.0
- **Commit:** `30c3452fd1292860482f1afc7908edb76a46f1ed`
- **License:** MIT
- **Adapted:** Directory entrypoint, peer dependency style, root-relative test/lint scripts, planning-handoff cleanup/provenance, compact tool rendering, and a single `Task` tool (`op: create/update/list/get`) with no background-process tools.
