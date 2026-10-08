# pi-goal

Persistent `/goal` support for pi, porting Codex-style goal mode: a thread-scoped goal store, hidden continuation prompts that keep the agent working toward the objective, token/elapsed-time accounting with optional token budgets, a `blocked` escape hatch, and a Codex-style footer indicator.

## Origin and maintenance

Independently maintained in Panda Harness. Origin: [code-yeongyu/pi-goal](https://github.com/code-yeongyu/pi-goal), distributed through [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/pi-goal). The original MIT copyright and permission notice remain in [LICENSE](LICENSE).

## Tools

- `create_goal` — create an active goal with an `objective` and optional `token_budget`; fails if an unfinished goal exists.
- `update_goal` — set `status` to `complete` only when the objective is achieved, or `blocked` with a specific nonempty `blockedReason` after an exhausted external-state or unanswered-user impasse recurs for ≥3 consecutive Goal turns. This is a floor, not an attempt cap; live background results and pending questions remain waits, not blockers. Pause/resume are user-controlled.
- `get_goal` — return the current goal, usage, and budget.
- `/goal [<objective>|pause|resume|clear]` — show, set, pause, resume, or clear the goal.

Tool schemas, the command, and lifecycle hooks are registered in [`src/index.ts`](src/index.ts).

Goal tools use native deferred exposure: fresh sessions do not declare them until accepted ULW or explicit `/goal` activation. Restored unfinished Goals retain policy-permitted management tools. [Access](src/goal/access.ts) remains session-scoped; Goal owns activation of its own tools, and modes (when loaded) only gate permission over that set. ULW supplies only an activation signal; Goal injects a separate hidden [bootstrap](src/goal/bootstrap.ts) asking the model to inspect the Goal and create one only for the agreed task. It never deterministically creates or resumes a Goal.

## Settings / Configuration

No config file. Goal state persists as JSON keyed by thread id, under the session directory or `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`) when there is no session. Paths are resolved in [`src/goal/context.ts`](src/goal/context.ts); statuses are defined in [`src/goal/types.ts`](src/goal/types.ts).

## Runtime contracts

- Cancellation persists `paused`, including in-flight provider/tool cancellation. The next ordinary interactive/RPC message offers **Keep paused** first (the default) or **Continue existing goal**. Dismissal or unavailable UI keeps it paused; that decision survives reopening until another cancellation. Explicit pause does not create this offer. Provider errors do not arm it.
- Continue appends the message verbatim and resumes the same Goal in that user-triggered run, without replay or an extra turn. The original objective, identity, creation time, accumulated usage, elapsed time and token budget remain intact. Exhausted budgets permit only wrapup, not substantive work.
- Active interactive/RPC steering is accepted as an amendment at submission, without a dialog or restart. Accepted amendments survive later cancellation even when no provider request receives the steer; acceptance records are not delivery receipts. Replacing or clearing a Goal never transfers its amendments. Native input, attachments and expansion remain unchanged.
- Ordered amendments stay distinct from the original objective in inspection and [continuation context](src/goal/prompt.ts). The latest explicit instruction resolves conflicts without dropping unrelated requirements; questions and information do not automatically redefine scope. Ambiguous disputed work requires clarification.
- [Store](src/goal/store.ts) mutations serialize the entire read-modify-write through Pi's native file queue and publish via a private same-directory atomic rename. This is process-local serialization with one active Pi owner per session, not cross-process locking.
- Delayed mutations check Goal identity, status, control generation, and the amendment version supplied to the responding model. An in-flight response cannot complete or block scope amended after its provider request. Model updates cannot overwrite paused or replaced Goals, resume, or change budgets. Block metadata survives reads and clears on leaving blocked.
- Accounting runs at `agent_end`; clean automatic continuation uses native actionable `agent_before_settle` entries. Restore and explicit commands share single-flight admission. Hidden context for an active Goal refreshes to its original objective and all current amendments before the next provider request; obsolete identity/status context and stale text are excluded without duplicating current context; Pi offers no selective dequeue for already-sent idle-start messages.
- Token budgets remain a hard substantive-work ceiling, with one usage wrapup; completion finalizes in-flight usage. User cancellation remains paused even when its final usage exceeds budget.
- [Prompts](src/goal/prompt.ts) treat the objective as untrusted data and require current evidence per requirement. Semantic completion, exhausted paths, and repeated blockers remain model audits, not runtime proofs or universal wake-source tracking.

## Display and integration

- **Compact tool-result rendering** (`src/goal/render.ts`): the `create_goal`/`get_goal`/`update_goal` tools show a collapsed `keyword: content` summary (objective, status, elapsed time, tokens) with an expand hint; expanding shows the raw JSON. Model-visible `result.content` is unchanged.
- **Footer bridge:** the goal status indicator is published for the `qol` extension's footer instead of clobbering the shared footer slot; a standalone Codex-style footer is the fallback when `qol` is absent.
- **Shared context reader** (`src/goal/context.ts`): `goalStoreRef` is the single context-to-storage resolver; `readGoalForContext` returns a Goal or null and propagates lookup errors. Tasks defers continuation for every existing Goal status and fails closed on lookup errors; this does not affect Goal scheduling.
