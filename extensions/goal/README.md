# pi-goal

Persistent `/goal` support for pi, porting Codex-style goal mode: a thread-scoped goal store, hidden continuation prompts that keep the agent working toward the objective, token/elapsed-time accounting with optional token budgets, a `blocked` escape hatch, and a Codex-style footer indicator.

## Upstream

- Source: https://github.com/code-yeongyu/oh-my-openagent (monorepo path `packages/pi-goal`, branch `dev`)
- Upstream package: `@oh-my-opencode/pi-goal` v4.15.1 (vendored in that monorepo from `code-yeongyu/pi-goal`)
- Commit: `dec381ed201a1326883db9f42bdb3c2add91b299`
- License: MIT (`LICENSE` vendored)
- Local changes: vendors upstream `src/` and `test/`; pi peer imports use `@earendil-works/*`; tests run under `vitest` (with `vi` fake timers); a root `index.ts` re-export shim supports this repo's `extensions/<name>/index.ts` discovery; upstream `package.json`/tsconfig/biome/CI/`SKILL.md` are omitted because root catalog deps and tooling cover them.

## Tools

- `create_goal` — create an active goal with an `objective` and optional `token_budget`; fails if an active goal exists.
- `update_goal` — set `status` to `complete` only when the objective is achieved, or `blocked` only after the same blocking condition recurs for ≥3 consecutive turns. Pause/resume are user-controlled.
- `get_goal` — return the current goal, usage, and budget.
- `/goal [<objective>|pause|resume|clear]` — show, set, pause, resume, or clear the goal.

Tool schemas, the command, and lifecycle hooks are registered in [`src/index.ts`](src/index.ts).

## Settings / Configuration

No config file. Goal state persists as JSON keyed by thread id, under the session directory or `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`) when there is no session. Paths are resolved in [`src/goal/context.ts`](src/goal/context.ts); statuses are defined in [`src/goal/types.ts`](src/goal/types.ts).

## Local Additions

Local features on top of upstream:

- **Compact tool-result rendering** (`src/goal/render.ts`): the `create_goal`/`get_goal`/`update_goal` tools show a collapsed `keyword: content` summary (objective, status, elapsed time, tokens) with an expand hint; expanding shows the raw JSON. Model-visible `result.content` is unchanged.
- **Footer bridge:** the goal status indicator is published for the `qol` extension's footer instead of clobbering the shared footer slot; a standalone Codex-style footer is the fallback when `qol` is absent.
- **Shared context reader** (`src/goal/context.ts`): `goalStoreRef` is the single context-to-storage resolver; `readGoalForContext` returns a Goal or null and propagates lookup errors. Tasks defers continuation for every existing Goal status and fails closed on lookup errors; this does not affect Goal scheduling.
