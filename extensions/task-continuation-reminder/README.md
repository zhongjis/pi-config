# task-continuation-reminder

Injects a system reminder about incomplete tasks when the agent stops with unfinished work.

## What It Does

- On `agent_end`, checks if there are incomplete tasks in the task store
- If incomplete tasks exist and the agent stopped normally (not aborted/errored), injects a follow-up message prompting the agent to continue
- Includes stagnation detection: stops re-injecting after 3 consecutive single-turn attempts with no progress
- Respects `awaitingUserAction.suppressContinuationReminder` flag from other extensions
- Respects `user-prompted` events (skips reminder if user was prompted during the run)
- Depends on the `tasks` extension (imports `TaskStore` and `loadTasksConfig`)

## Hooks

- `agent_start` — Reset turn counter and flags
- `agent_end` — Check for incomplete tasks, inject continuation reminder if needed
- `turn_end` — Increment turn counter
- Listens to `user-prompted` event via `pi.events`
