# pi-goal

Persistent `/goal` support for pi, porting Codex-style goal mode: a thread-scoped goal store, hidden continuation prompts that keep the agent working toward the objective, token/elapsed-time accounting with optional token budgets, a `blocked` escape hatch, and a Codex-style footer indicator.

## Upstream

- Source: https://github.com/code-yeongyu/oh-my-openagent (monorepo path `packages/pi-goal`, branch `dev`)
- Upstream package: `@oh-my-opencode/pi-goal` v4.15.1 (vendored in that monorepo from `code-yeongyu/pi-goal`)
- Last synced commit: `dec381ed201a1326883db9f42bdb3c2add91b299`
- License: MIT (`LICENSE` vendored)
- Local changes summary: copied upstream `src/` and `test/` into `extensions/goal/`; migrated pi peer imports from the old `@mariozechner/*` scope to `@earendil-works/*`; migrated the test suite from `bun:test` to `vitest` (incl. `setSystemTime` → `vi` fake timers); added a root `index.ts` re-export shim for this repo's `extensions/<name>/index.ts` discovery; omitted upstream `package.json`/tsconfig/biome/CI/`SKILL.md` because root catalog deps and root tooling already cover them.

## Tools

### `create_goal`

Create a new active goal (or replace the current goal when it is complete). Fails if an active goal already exists.

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `objective` | string | Yes | Concrete objective to pursue. |
| `token_budget` | integer | No | Positive token budget; goal becomes `budgetLimited` when exhausted. Omit unless explicitly requested. |

### `update_goal`

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `status` | `"complete"` \| `"blocked"` | Yes | `complete` only when the objective is achieved; `blocked` only after the same blocking condition recurs for ≥3 consecutive turns. Pause/resume are user-controlled. |

### `get_goal`

Return the current goal for this thread (status, token and elapsed-time usage, budget). No parameters.

## Commands

- `/goal <objective>` — set or replace the goal (prompts to confirm replacement when one exists).
- `/goal` — show the current goal.
- `/goal pause` — pause autonomous continuation without deleting the goal.
- `/goal resume` — reactivate a paused goal.
- `/goal clear` — remove the goal.

## Hooks

- `session_start` — load goal, restore accounting, offer to resume a paused goal on `resume`, queue the continuation prompt when idle.
- `agent_start` / `agent_end` — track per-turn token/time usage, enforce the token budget (→ `budgetLimited`), and queue the hidden continuation prompt while the goal stays `active`.
- `session_shutdown` — flush accounting and clear in-memory state.

## Settings / Configuration

No config file. Goal state persists as JSON keyed by thread id:

- With a session: `<sessionDir>/extensions/goal/<threadId>.json`.
- Without a session: `$PI_CODING_AGENT_DIR/extensions/goal/no-session/<cwd-hash>/<threadId>.json` (defaults under `~/.pi/agent`).

Statuses: `active`, `paused`, `blocked`, `budgetLimited`, `complete`.
