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

Lists all tasks with status, owner, and blocked-by info. Sorted: pending → in_progress → completed.

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

Tasks must be `pending`, have `agentType` set, and all blockers completed. Requires [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).

## Widget

```
Tasks  ✔2 ◼1 ◻3
 ✔ #1 Fix auth bug
 ✳ #2 Write unit tests (agent-1) 2m 14s · 8.2k tok
 ◻ #3 Update docs [blocked by #2]
```

## Commands

`/tasks` — interactive menu: view tasks, create task, clear all, settings.

## Settings

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `taskScope` | `memory` / `session` / `project` | `memory` | Where tasks persist |
| `autoCascade` | boolean | `false` | Auto-execute unblocked dependents |
| `autoClearCompleted` | boolean | `false` | Remove completed tasks automatically |

Persisted to `.pi/tasks-config.json`. Override scope with `PI_TASKS` env var (path to shared JSON file).

## Storage

- `memory` — in-process only, lost on exit
- `session` — `.pi/tasks-session.json`, per-session
- `project` — `.pi/tasks.json`, shared across sessions

## Events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `subagents:completed` | listen | Mark task completed on agent success |
| `subagents:failed` | listen | Mark task failed on agent error |
| `subagents:rpc:spawn` | emit | `TaskExecute` spawns a subagent |

## Upstream

Source: [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) (MIT). Vendored with local modifications.
