# Pi Goal-backed ULW loop

Status: idea

Tracker: https://github.com/zhongjis/pi-config/issues/9

## Problem Statement

Users may want Ultrawork rigor to continue across multiple autonomous turns, but adding a second Ralph-style loop controller would duplicate Pi Goal's continuation, persistence, accounting, completion, pause, reload, and budget behavior. Duplicate controllers could queue competing follow-ups, disagree about completion, corrupt lifecycle state, or make stop behavior unclear.

Bare `ulw` is intentionally a one-shot invocation. Users need an explicit `/ulw-loop` workflow that feels like Ultrawork while remaining operationally identical to a Pi Goal: one active, branch-scoped objective owned by the existing Pi Goal runtime.

## Solution

Add `/ulw-loop` as a thin, explicit adapter to Pi Goal. The command accepts a task and optional Pi Goal token budget, converts the task into a durable Ultrawork-flavored goal contract, then delegates activation through Pi Goal's public `/goal` command. Pi Goal remains the sole owner of state, continuation scheduling, turn accounting, completion, pause/resume/clear, budget limiting, transcript markers, and footer status.

The adapter does not implement an iteration loop, persist private loop state, forge Pi Goal session entries, or emit a second continuation message. Bare `ulw` remains one-shot. `/ulw-loop` is available only in Kua Fu and requires Pi Goal to be installed and available. Existing `/goal` commands control the resulting lifecycle.

## User Stories

1. As a Kua Fu user, I want `/ulw-loop <task>` to start durable autonomous work, so that complex work can continue across turns.
2. As a Kua Fu user, I want `/ulw-loop` to use Pi Goal, so that one runtime owns continuation and completion.
3. As a Pi user, I want bare `ulw` to remain one-shot, so that ordinary invocation never starts an autonomous loop.
4. As a Pi user, I want `/ulw-loop` to be explicit, so that persistent autonomous work cannot start accidentally from keyword text.
5. As a Pi user, I want the loop objective to include concrete outcome criteria, so that completion is auditable.
6. As a Pi user, I want the loop objective to include verification surfaces, so that success requires real evidence.
7. As a Pi user, I want the loop objective to preserve stated constraints and boundaries, so that autonomy does not expand scope.
8. As a Pi user, I want the loop objective to define an iteration policy, so that each continuation chooses a defensible next action.
9. As a Pi user, I want the loop objective to define a blocked stop condition, so that the agent reports blockers instead of drifting.
10. As a Pi user, I want Ultrawork rigor represented in the goal contract, so that each continuation retains strict implementation and verification expectations.
11. As a Pi user, I want `/ulw-loop --tokens 50k <task>` to use Pi Goal's token budget, so that autonomous work has a hard resource bound.
12. As a Pi user, I want invalid or non-positive budgets rejected using Pi Goal semantics, so that budget behavior stays consistent.
13. As a Pi user, I want an empty `/ulw-loop` invocation rejected with concise usage guidance, so that no vague goal is created.
14. As a Pi user, I want the original task text preserved in the generated objective, so that command adaptation does not change intent.
15. As a Pi user, I want quoted and multiline task content preserved, so that detailed objectives remain usable.
16. As a Pi user, I want `/goal status` to inspect an Ultrawork loop, so that no second status command is required.
17. As a Pi user, I want `/goal pause` to stop autonomous continuation, so that interruption uses an existing control.
18. As a Pi user, I want `/goal resume` to restart a paused Ultrawork loop, so that continuation uses an existing control.
19. As a Pi user, I want `/goal clear` to remove an Ultrawork loop, so that cancellation uses an existing control.
20. As a Pi user, I want the model to call `update_goal({ status: "complete" })` only after a strict evidence audit, so that completion remains trustworthy.
21. As a Pi user, I want reload to pause an active Ultrawork loop, so that it never resumes silently after runtime changes.
22. As a Pi user, I want resumed and forked sessions to follow Pi Goal's branch-scoped state rules, so that loop state matches conversation history.
23. As a Pi user, I want one compact Goal lifecycle marker and one Goal footer status, so that the UI has one source of truth.
24. As a Pi user, I do not want a separate Ultrawork loop footer, so that duplicate persistent indicators cannot disagree.
25. As a Pi user, I want pending user or extension messages to take precedence over automatic continuation, so that the loop does not race explicit input.
26. As a Pi user, I want token and time usage accounted by Pi Goal, so that resource reporting remains consistent.
27. As a Pi user, I want budget exhaustion to produce Pi Goal's wrap-up behavior, so that the agent stops substantive work cleanly.
28. As a Pi user, I want an existing unfinished goal replacement to use Pi Goal's confirmation flow, so that `/ulw-loop` cannot silently overwrite work.
29. As a non-Kua Fu mode user, I want `/ulw-loop` rejected with guidance, so that mode-specific orchestration does not leak into other personas.
30. As a Pi user, I want missing Pi Goal support reported clearly, so that the command fails closed instead of pretending a loop started.
31. As a Pi user, I want duplicate or ambiguous `/goal` command registration detected, so that the adapter never delegates to an unknown owner.
32. As a maintainer, I want `/ulw-loop` to use Pi's public user-message/command path, so that it does not import Pi Goal internals.
33. As a maintainer, I want Pi Goal's custom session entries treated as private, so that adapter upgrades cannot corrupt goal state.
34. As a maintainer, I want Pi Goal's continuation events treated as private, so that the adapter cannot forge lifecycle messages.
35. As a maintainer, I want no new cross-extension event family, so that the integration has no additional shared event contract.
36. As a maintainer, I want no adapter-owned `agent_end` continuation hook, so that only Pi Goal schedules follow-ups.
37. As a maintainer, I want no adapter-owned token accounting, so that usage cannot be counted twice.
38. As a maintainer, I want no adapter-owned completion state, so that Pi Goal remains authoritative.
39. As a maintainer, I want the integration pinned to a compatible Pi Goal version, so that public command behavior cannot drift silently.
40. As a maintainer, I want a real-runtime integration test loading both extensions, so that command handoff and continuation are proven together.
41. As a maintainer, I want unit tests limited to argument parsing and goal-contract construction, so that tests avoid duplicating Pi Goal internals.
42. As a maintainer, I want a regression proving bare `ulw` creates no goal, so that issue #8's one-shot contract remains intact.
43. As a maintainer, I want a regression proving normal `/goal` behavior remains unchanged, so that the adapter does not become a replacement controller.
44. As a maintainer, I want adapter failure to create no persistent state or status, so that partial activation cannot mislead users.
45. As a maintainer, I want documentation to call this a Pi Goal preset rather than a new loop engine, so that ownership is clear.

## Implementation Decisions

- `/ulw-loop` is a command, not an input keyword. Bare `ulw` and `ultrawork` keep their one-shot contract.
- The command is gated to Kua Fu and does not switch modes automatically.
- Supported syntax is `/ulw-loop [--tokens <positive budget>] <task>`. Budget syntax and units mirror Pi Goal.
- The adapter builds a self-contained goal objective containing the user's task plus Ultrawork-oriented outcome, verification, scope, iteration, and blocked-stop requirements.
- The generated contract must be concise enough for repeated Pi Goal continuation messages; it must not embed the entire large one-shot Ultrawork directive.
- Activation delegates through Pi Goal's public `/goal` command using Pi's user-message command path. The adapter does not call private functions or mutate module-local state.
- Pi Goal owns active state, branch persistence, transcript lifecycle markers, footer status, tool exposure, turn accounting, continuation deduplication, completion, budget limiting, pause, resume, clear, reload behavior, and pending-message guards.
- The adapter owns only command parsing, Kua Fu gating, dependency/command availability validation, goal-contract construction, and delegation.
- No new session schema, external state file, database, custom entry type, loop counter, completion promise, max-iteration state, or continuation scheduler is introduced.
- No new shared `pi.events` event family is introduced.
- The adapter must not inspect or forge Pi Goal's undocumented custom-entry fields, event details, or internal state types.
- Existing active goals follow Pi Goal's replacement confirmation behavior; the adapter must not bypass it.
- Missing, incompatible, duplicated, or ambiguously suffixed Pi Goal command registration fails closed with actionable feedback and no activation.
- The project must pin a compatible Pi Goal package/ref before enabling the command. Upgrades require contract revalidation.
- Issue #8's one-shot ULW alignment is an adjacent prerequisite: `/ulw-loop` must not reuse a persistent Ultrawork footer or hidden pending flag.

## Testing Decisions

- Use one highest integration seam: the real Pi runtime harness loads the ULW adapter and pinned Pi Goal extension, invokes `/ulw-loop`, then observes public session behavior.
- The primary happy-path test proves command delegation creates one active Pi Goal, emits one Goal activation marker, and allows Pi Goal alone to queue the next continuation after `agent_end`.
- A budget test proves `/ulw-loop --tokens 50k` yields Pi Goal's active goal with the matching budget and uses Pi Goal's normal accounting/limit behavior.
- A lifecycle test proves `/goal pause`, `/goal resume`, `/goal clear`, and reload behavior work unchanged for a goal started through `/ulw-loop`.
- A pending-message test proves Pi Goal does not queue a competing continuation when another message is pending.
- A dependency-failure test proves absent or ambiguous Pi Goal command availability produces an error and no Goal marker, footer, or persisted state.
- A mode-gate test proves non-Kua Fu invocation creates no goal.
- An adjacent regression proves bare `ulw` transforms one prompt but creates no Pi Goal state or continuation.
- Another adjacent regression proves direct `/goal` retains its normal behavior when the adapter is loaded.
- Focused unit tests cover only parser behavior, empty input, budget forwarding, preservation of quoted/multiline task text, and deterministic goal-contract construction.
- Tests assert external behavior: command results, transcript markers, statuses, public tool availability, subsequent turns, and branch restoration. They do not assert Pi Goal closure variables, private entry schemas, internal event details, or microtask implementation.
- Prior art is the existing Ultrawork extension unit/integration suite, mode command integration tests, Pi Goal's continuation-contract tests, and the real Pi test harness used by extension integration tests.

## Out of Scope

- Building or porting OMO Ralph Loop.
- Creating a second continuation controller, iteration counter, completion detector, or state store.
- Embedding the full one-shot Ultrawork directive into every continuation.
- Changing Pi Goal's lifecycle, state schema, renderer, footer, tools, accounting, or completion API.
- Adding a direct extension-to-extension service API to Pi Goal.
- Adding or changing shared event-bus contracts.
- Automatically switching to Kua Fu.
- Starting loops from bare `ulw` keyword detection.
- Supporting OMO-specific `--strategy`, completion promises, Oracle verification stages, or filesystem loop artifacts.
- Modifying task DAG, Boomerang, autoresearch, handoff, or mode state.

## Further Notes

This feature is intentionally a preset over Pi Goal, not an independent loop. Its value is ergonomic: one explicit command creates a strong, Ultrawork-shaped completion contract while reusing a tested persistent controller.

The initial implementation should favor command-level composition because Pi Goal exposes no documented direct extension API. If command delegation proves unreliable because of load order or command-name ambiguity, stop rather than importing internals. A future direct API belongs upstream in Pi Goal and requires its own versioned public contract.
