# Tasks

Claude Code-style task tracking with dependency management, persistent widget, background process tracking, and subagent integration.

## Tools

### `TaskCreate`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `activeForm` | string | no | Present continuous form for spinner |
| `agentType` | string | no | Agent type for subagent execution |
| `metadata` | object | no | Arbitrary key-value pairs |

### `TaskList`

Lists all tasks with status, owner, and blocked-by info. Non-empty output is grouped as Running, Ready, Blocked, then Completed. Ready means `pending`, no owner, and no unsatisfied blockers; ready tasks with `metadata.agentType` are marked executable for `TaskExecute`.

### `TaskGet`

Returns full details for a task including owner, dependencies, and metadata.

### `TaskUpdate`

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `activeForm` | string | Spinner text |
| `owner` | string | Agent name |
| `metadata` | object | Shallow merge (null deletes keys) |
| `addBlocks` | string[] | Task IDs this task blocks |
| `addBlockedBy` | string[] | Task IDs that block this task |

Dependencies are bidirectional. `status: "deleted"` permanently removes a task.

### `TaskOutput`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | — | Task ID or agent ID (required) |
| `block` | boolean | `true` | Wait for completion |
| `timeout` | number | `30000` | Max wait ms (max 600000) |

### `TaskStop`

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | string | Task ID or agent ID to stop |

Sends SIGTERM, waits 5s, then SIGKILL. For subagent tasks, sends a stop RPC.

### `TaskExecute`

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_ids` | string[] | Task IDs to execute (required) |
| `additional_context` | string | Extra context per agent |
| `model` | string | Model override |
| `max_turns` | number | Max turns per agent |

Tasks must be `pending`, have `agentType` set, and all blockers completed. Requires the `@panda/pi-subagents` extension (Phase 2 hard fork of the upstream `pi-subagents` package).

When execution launches at least one task and other executable ready tasks remain unrequested, the result includes `Also ready: #...` with a tip to pass multiple `task_ids` when parallel execution is safe. This is advisory only; it does not change `autoCascade` or require parallel execution.

## Widget

The widget appears while tasks exist. It shows counts for running, ready, blocked, and done tasks; active/running and ready work are listed before blocked and completed work when space is limited.

```
Tasks · 1 running · 2 ready · 1 blocked · 2 done
├─ ◐ #2 Write unit tests (agent abc12)
├─ ○ #3 Update docs
├─ ○ #4 Review output
├─ ○ #5 Release notes › blocked by #2
└─ … and 2 more
```

## Commands

`/tasks` — interactive menu: view tasks, create task, clear all, settings.

## Settings

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `taskScope` | `memory` / `session` / `project` | `session` | Where tasks persist |
| `autoCascade` | boolean | `false` | Auto-execute unblocked dependents |
| `autoClearCompleted` | `never` / `on_list_complete` / `on_task_complete` | `on_list_complete` | Remove completed tasks after a turn delay |

Persisted to `.pi/tasks-config.json`. Override scope with `PI_TASKS` env var (`off`, named list, or file path).

## Storage

- `memory` — in-process only, lost on exit
- `session` — `.pi/tasks/tasks-<sessionId>.json`, per-session
- `project` — `.pi/tasks/tasks.json`, shared across sessions

On-disk state carries a `schemaVersion` field (current = `2`). The store migrates legacy v1 files (no `schemaVersion`) to v2 on first write, inside the advisory lock.

## Restoring from pre-v2 snapshot

Before the first v1 → v2 upgrade, the entire `~/.pi/tasks/` directory is snapshotted to `~/.pi/tasks.bak-pre-v2-<ts>/`. Snapshots are never auto-deleted. To restore:

```bash
cp -r ~/.pi/tasks.bak-pre-v2-<ts>/ ~/.pi/tasks/
```

Replace `<ts>` with the timestamp suffix of the snapshot directory you want to restore.

## Events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `subagents:completed` | listen | Mark task completed on agent success |
| `subagents:failed` | listen | Mark task failed on agent error |
| `subagents:rpc:spawn` | emit | `TaskExecute` spawns a subagent |

## Upstream

- **Source:** https://github.com/tintinweb/pi-tasks
- **Version:** 0.5.0
- **Commit:** `30c3452fd1292860482f1afc7908edb76a46f1ed`
- **License:** MIT
- **Adapted:** Directory entrypoint (`./index.ts`), peer dependency style, root-relative Vitest/Biome scripts, chengfeng-oriented task examples, planning-handoff cleanup RPC/provenance behavior, and a local `TaskRunner` seam (`src/task-runner.ts`) behind which `TaskOutput`/`TaskStop` dispatch process- vs subagent-backed tasks.
