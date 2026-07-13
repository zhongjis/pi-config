# Task Tools v3

Status: draft

## Problem Statement

An agent needs a small, durable task tool to record work, track dependencies, find ready tasks, mark current work, and preserve progress across context compaction and session resume.

The current task extension combines that task-management job with subagent execution. It owns a private JSON store, dependency graph, locking, migrations, readiness logic, widget state, subagent bindings, and the `TaskExecute`, `TaskOutput`, and `TaskStop` tools. As a result:

- basic task management depends on executor lifecycle code and subagent RPCs;
- runtime completion can mutate logical task state;
- task storage, graph repair, synchronization, and locking are maintained locally even though Beads provides those capabilities;
- mode-specific planning and delegation behavior reaches into the task extension;
- agents receive a larger tool and prompt surface than they need to manage their own work;
- replacing the task backend requires changes across unrelated extensions and agent protocols.

The agent needs one standalone Task extension. The extension should manage durable logical tasks only. It must not spawn agents, supervise execution, intercept agent results, implement review workflows, or require changes to outer extensions.

## Solution

Replace the private JSON task backend with Beads while preserving a narrow, harness-native task-tool interface. Any agent whose tool set includes Task Tools can use the same generic tools to create, inspect, claim, update, complete, reopen, and organize its tasks.

The complete runtime path is:

```text
Agent
  uses generic Task tools

Task extension
  validates task operations, invokes BeadsClient, normalizes results, and renders task UI

BeadsClient
  runs bounded bd CLI commands through the JSON interface

Beads
  owns durable task records, dependencies, readiness, assignment, comments, and history
```

This is the only workflow introduced by v3. The Task extension does not call the subagent extension, register task-execution RPCs, modify mode behavior, inspect Worker output, create Reviewer agents, or maintain issue-to-execution bindings.

The registered Task-tool contract is the primary interface and highest testing seam. One internal `BeadsClient` seam isolates CLI/version behavior from tool behavior. No additional public orchestration seam is introduced.

The tool descriptions may add concise lifecycle guidance: create tasks when work becomes concrete, claim or mark a task `in_progress` before starting, and mark it `completed` only after the agent verifies the work. This prompt guidance does not modify agent definitions or outer extensions.

## User Stories

1. As an agent, I want generic task tools independent of mode names, so that I can manage work through one contract.
2. As an agent, I want Task Tools available whenever the extension is loaded for me, so that I do not need a coordinator capability or special role.
3. As an agent, I want to create a task with a subject and description, so that concrete work is recorded before I begin.
4. As an agent, I want to add an active-form label, so that current work can be shown clearly in the task widget.
5. As an agent, I want to attach bounded tags and durable source references to a task, so that useful context survives without an open-ended metadata channel.
6. As an agent, I want to list my pending, in-progress, blocked, ready, and completed tasks, so that I can choose the next action.
7. As an agent, I want ready tasks shown separately from blocked tasks, so that dependency state is immediately useful.
8. As an agent, I want to inspect one task with its dependencies and history, so that I can resume work after compaction.
9. As an agent, I want to update a task's definition, so that clarified requirements remain attached to the work.
10. As an agent, I want to add and remove blocking dependencies, so that readiness follows the actual work order.
11. As an agent, I want invalid, missing, duplicate, self, and cyclic dependencies rejected, so that the task graph remains usable.
12. As an agent, I want only blocking dependencies to affect readiness, so that informational metadata cannot accidentally stop work.
13. As an agent, I want to atomically claim the next ready task, so that another concurrent agent session cannot claim the same work.
14. As an agent, I want a clear no-ready result when no task can be claimed, so that I do not mistake an empty queue for a tool failure.
15. As an agent, I want the extension to derive claim identity from the calling session, so that the model cannot spoof ownership parameters.
16. As an agent, I want a claimed task marked `in_progress`, so that my current work is visible.
17. As an agent, I want to release a task back to `pending`, so that unfinished work can become ready again.
18. As an agent, I want to mark my task `completed` explicitly, so that runtime exit or tool failure cannot imply success.
19. As an agent, I want to add a completion note or result reference, so that later sessions can understand what changed.
20. As an agent, I want to reopen completed work, so that regressions or incomplete outcomes can be tracked without creating duplicate tasks.
21. As an agent, I want task IDs to remain stable across updates, release, completion, and reopen, so that references remain valid.
22. As an agent, I want task state to survive context compaction, so that task history does not depend on conversation memory.
23. As an agent, I want resuming the same session to preserve my caller identity, so that I can continue claimed work.
24. As an agent, I want a new session to start with its own caller identity, so that ownership is not silently transferred.
25. As an agent, I want bounded errors when Beads is unavailable, so that a task command cannot hang my session.
26. As an agent, I want raw `bd`, Dolt SQL, credentials, and server details hidden behind Task Tools, so that I use a stable, safe interface.
27. As an agent, I want no task tool to spawn or stop agents, so that task management remains independent from execution.
28. As an agent, I want no background event to complete my tasks automatically, so that completion always reflects an explicit task action.
29. As an agent, I want task management to remain independent from PLAN, Handoff, review, and delegation protocols, so that those workflows can evolve separately.
30. As a human, I want tool availability to remain the authorization boundary, so that the Task extension does not invent another agent-role system.
31. As a human, I want task operations logged without secrets, so that task changes are auditable.
32. As an operator, I want Beads pinned and project-managed through Nix, so that installations are reproducible.
33. As an operator, I want embedded and server-backed Beads operation selected by project configuration, so that single-writer and concurrent use are both supported.
34. As an operator, I want the Task extension never to start or stop the Beads server, so that process ownership remains explicit.
35. As an operator, I want dry-run migration, parity checks, backups, and rollback, so that replacing the legacy store is recoverable.
36. As a maintainer, I want one typed `BeadsClient`, so that CLI changes stay local to one module.
37. As a maintainer, I want registered Task tools to be the primary contract-test seam, so that tests verify agent-visible behavior.
38. As a maintainer, I want the existing task widget adapted to normalized task data, so that UI remains a projection rather than a second source of truth.
39. As a maintainer, I want all subagent bridge, task runner, execution RPC, and execution-tool code removed from the Task extension, so that the module has one responsibility.
40. As a future agent author, I want to add Task Tools through the normal tool allowlist, so that no mode-specific task integration is required.

## Implementation Decisions

1. V3 is a standalone Task extension. It manages logical tasks only and has no dependency on the subagent extension, mode extension, Handoff extension, multimodal delegation, or any other outer extension.
2. Beads becomes the sole task-system source of truth after cutover. The legacy JSON stores remain untouched during rollback retention, then are removed only through a separate operator decision.
3. The extension invokes the installed `bd` CLI through one typed `BeadsClient` using JSON output. Agents never receive raw shell, SQL, `bd`, or Dolt administration through Task Tools.
4. `beads-mcp` is not used. The harness already owns tool registration, permission, rendering, and prompt surfaces; another protocol would add an unnecessary seam.
5. The Nix flake pins Beads `v1.1.0` at commit `8e4e59d39f3459a43cf21a3236a13eca4dd874f7` with source hash `sha256-+dFV//0N8ZDw9BHOJOoWZ+BvLmJKlnGtONHIYPRhfBE=`. The development shell and runtime wrapper consume the project package. No global npm package or curl installer is used.
6. Project configuration selects embedded or server-backed Beads operation. Embedded mode supports explicitly single-writer use. Concurrent agent sessions require server mode. The Task extension validates configured availability but never starts or stops `dolt sql-server`.
7. Beads data uses its project namespace. Server data, credentials, and backups remain operator-managed and outside committed runtime state. Connection values enter only the Task extension process environment and never appear in prompts or tool results.
8. The `BeadsClient` runs bounded commands, validates JSON, normalizes errors, checks compatible versions, and redacts sensitive configuration fields. Every public task operation has an explicit timeout. Public task content is not a secret store: schemas expose only named fields, reject unknown fields, enforce size/type limits, reject control characters, and scan every persisted string for every nonempty known injected secret value. A match anywhere in a string rejects persistence; sanitized logs replace matches with `[REDACTED]`.
9. Public tools remain generic and mode-neutral. Tool availability through the harness allowlist is the authorization decision. The extension does not classify callers as coordinator, Worker, Reviewer, Fu Xi, Houtu, or any other mode role.
10. The initial public contract contains `TaskCreate`, `TaskList`, `TaskGet`, `TaskClaim`, and `TaskUpdate`. Public names remain provisional only until implementation begins; no execution tools are included.
11. `TaskCreate` creates an unassigned logical task. Inputs are subject (1–200 characters), description (1–20,000 characters), optional active form (1–200 characters), up to 20 lowercase slug-like tags of 1–64 characters, up to 20 source references of 1–2,048 characters, and up to 100 existing blocking task IDs. Source references must be project-relative paths or URIs using the `local`, `http`, `https`, or `git` scheme. Creation provenance comes from trusted calling-session context.
12. `TaskList` accepts optional status (`pending`, `in_progress`, or `completed`), readiness (`ready` or `blocked`), and ownership (`mine`, `unassigned`, or `all`) filters plus an opaque cursor and limit from 1–100, default 50. Its default projection groups current-caller work, unassigned ready work, blocked work, and completed work. It does not mutate task state.
13. `TaskGet` accepts one task ID plus an optional history cursor and history limit from 1–100, default 50. It returns one normalized task, direct blocking relationships, ownership, timestamps, tags, source references, completion note, result references, a bounded history page, and the next history cursor when present. Each history event is capped at 32 KiB, history content at 128 KiB, and the entire response at 256 KiB; overflow is replaced by a truncation marker, SHA-256 digest, and durable Beads-history reference.
14. `TaskClaim` accepts no model-controlled task or owner ID. It uses `bd ready --claim --json` to atomically select and claim the next ready task for the trusted calling-session identity. No-ready is a successful empty result, not an error. V3 does not support directed named claim because Beads v1.1.0 cannot atomically validate a named task's dependencies and claim it in one operation.
15. Claim identity comes from trusted tool-call context and maps to the current session. The model cannot provide or override its claim identity. Resuming the same session restores that identity; a new session receives a new identity.
16. `TaskUpdate` uses one explicit action per call and rejects unknown fields. `edit` accepts the same subject, description, active-form, tag, and source-reference limits as `TaskCreate`; any Task-tool-authorized agent may edit a pending, unassigned task, while only the assignee may edit an in-progress task. `dependency` adds or removes exactly one blocker and is available to any authorized agent only while the task is pending and unassigned. `release` is allowed only for the current assignee of an in-progress task. `complete` is allowed only for that assignee and accepts an optional 0–8,000-character completion note plus up to 20 result references using the source-reference limits and schemes. Any authorized agent may `reopen` a completed task with an optional 0–2,000-character reason. Completed tasks must be reopened before their definition or dependencies change.
17. Tool success payloads have stable shapes: `TaskCreate` and `TaskUpdate` return `{ task }`; `TaskList` returns summary-only `{ groups, counts, nextCursor }` with at most the requested page size and a 128 KiB total-response cap; `TaskGet` returns `{ task, history, nextHistoryCursor }` under Decision 13's byte caps; `TaskClaim` returns `{ task }` or `{ task: null }`. Errors return `{ code, message, retryable, task? }`. Required codes cover not found, invalid input, invalid transition, not owner, blocked, conflict, unavailable backend, timeout, and incompatible backend.
18. No runtime event changes task state. Agent termination, tool failure, background process exit, subagent completion, and session end leave task state unchanged.
19. Beads owns issue identity, statuses, assignment, dependency edges, readiness, comments, history, and synchronization. The Task extension owns validation, normalization, caller identity mapping, tool descriptions, and widget projection.
20. Task state exposed to agents remains `pending`, `in_progress`, and `completed`. The extension maps these states to Beads open/assignment/closed behavior without exposing storage-specific details.
21. Blocking dependencies are the only relationships required by v3. Each dependency action changes one edge. Any Task-tool-authorized agent may change edges only while the dependent task is pending and unassigned; claimed or completed task graphs are immutable until release or reopen. The extension rejects missing endpoints, duplicates, self-edges, cycles, and graph mutations that would make readiness ambiguous. No epic is required to create or manage a task.
22. Task IDs remain stable through all supported lifecycle changes. Reopen does not create a new task.
23. Tool availability is the task-management authorization boundary. Agents may inspect project tasks, edit pending/unassigned definitions, change pending/unassigned dependencies, and reopen completed tasks. Beads assignment alone protects active work: only the current assignee may edit, release, or complete an in-progress task. Conflicts return the current task snapshot. Creation/completion identities are audit provenance, not extra authorization layers.
24. A new session does not inherit another session's assignment. Reassignment or administrative recovery, if needed, is an explicit human/operator action outside the agent tool contract.
25. The existing task widget is retained as a read-only projection of normalized Beads data. It shows ready, blocked, in-progress, and completed counts plus the current caller's active task. Widget state never drives lifecycle.
26. Tool descriptions and `promptGuidelines` may tell agents to create concrete tasks, claim before work, check blockers, and complete only after verification. No mode prompt, agent definition, or outer-extension prompt is changed.
27. `TaskExecute`, `TaskOutput`, and `TaskStop` are removed. The task runner, subagent bridge, subagent event listeners, execution RPC handlers, automatic graph advancement, `agentType` execution metadata, process metrics, execution bindings, and auto-cascade behavior are removed from the Task extension.
28. No replacement orchestration adapter or execution-binding registry is created. V3 adds no attempt entity, generation counter, `awaiting_review` state, Worker submission path, Reviewer protocol, or execution-recovery workflow.
29. The extension does not parse `local://PLAN.md`, perform Handoff cleanup, modify mode behavior, alter subagent tool allowlists, or update task consumers in outer extensions. Those integrations may continue using generic task tools only if their existing prompts choose to do so.
30. Task APIs never wait without a bound. Health failures return structured errors with a recovery action. Optional context injection such as `bd prime` is not required by v3.
31. Task operations and migration emit task-domain audit information through Beads history and sanitized extension logs. No separate execution audit file is introduced.
32. Migration scans every configured legacy persistent source using the old extension's resolution rules. `PI_TASKS=off` has no records. Memory scope is non-migratable and must be drained before cutover.
33. Each supported legacy task maps directly to one Beads task; migration does not invent epics. Deterministic mapping records source scope and legacy ID to prevent collisions across project, shared, and session stores.
34. `pending` maps to open and unassigned. Legacy `in_progress` also becomes `pending` and unassigned, with its prior status and owner retained only as provenance; it must pass normal readiness and `TaskClaim` before becoming `in_progress` again. `completed` maps to closed with a `legacy-pre-v3` label and historical result note. Legacy deleted records are reported but not reinterpreted.
35. Legacy subject, description, active form, owner provenance, timestamps, blocking relationships, allowlisted tags/source references, historical result text, and source provenance map to normalized Beads fields, labels, or comments. A historical result is limited to 32 KiB inline; overflow moves to the immutable migration artifact and stores a truncation marker, SHA-256 digest, and artifact reference in Beads. Unknown metadata remains only in the migration report. `agentType`, runtime agent IDs, process state, credentials, and other execution-only metadata are excluded.
36. Valid legacy `blockedBy` relationships become Beads blocking dependencies after both endpoints map. Duplicate, self, cyclic, dangling, and asymmetric edges enter the unsupported-record report. Migration performs no silent repair.
37. Dry run produces an immutable artifact containing project root, source scope/path, source digest, record counts, mapping, unsupported records, proposed operations, and parity results. Dry run invokes no mutating Beads command.
38. Import first runs against a disposable database. Parity requires equal supported task counts, exact direct blocking-edge equivalence, equal ready sets after excluding converted legacy `in_progress` records from both sides, matching completed counts, and zero unreported records.
39. Cutover stops task writers, snapshots sources again, requires unchanged digests, imports production state, switches only the Task extension backend, and runs a create/list/claim/update/complete smoke workflow. Dual write is forbidden.
40. Rollback stops Beads task writers, restores the legacy Task extension against untouched final snapshots and original scope configuration, and verifies counts and ready sets before task use resumes.
41. Beads/schema upgrades require one migration authority, a full Dolt backup plus `bd export --all`, health validation, compatibility checks, and restore proof. JSONL export is interchange, not a complete backup.
42. Implementation changes are confined to the Task extension, its tests, its Task tool descriptions and `promptGuidelines`, project Beads/Nix configuration, migration utilities, and Task extension documentation. Before removing execution tools or RPCs, a repository-wide compatibility audit must prove that no outer extension source, agent/mode prompt, or other prompt text references them. Any such dependency blocks cutover; v3 neither edits the outer consumer nor adds a compatibility executor.

## Testing Decisions

Tests target the highest stable seam: registered Task tools backed by a fake `BeadsClient`. A smaller real-CLI suite verifies the adapter against an isolated Beads database. Tests assert agent-visible task behavior, not CLI command construction or internal module layout.

1. Contract tests cover create, list, get, edit, add/remove dependency, claim-next, no-ready, release, complete, reopen, history, and widget projection.
2. Tool-registration tests prove only task-management tools are registered and `TaskExecute`, `TaskOutput`, and `TaskStop` are absent.
3. Independence tests load the Task extension without the subagent, modes, Handoff, or other outer extensions and prove every Task tool works.
4. Adapter tests cover normalized success, malformed JSON, incompatible version, timeout, conflict, unavailable database, sensitive-configuration redaction, unknown-field rejection, control-character rejection, and refusal to persist known injected secret values appearing as whole values or substrings.
5. Real-CLI tests initialize an isolated database and run create/list/get/claim/update/complete/reopen/dependency round trips.
6. Claim-next tests prove two concurrent callers cannot successfully claim the same ready task.
7. Claim tests prove `TaskClaim` has no model-controlled task/owner input, blocked tasks are never selected, no-ready returns a successful empty result, and a real concurrent dependency/claim race cannot produce a blocker-bypassing claim.
8. Ownership tests prove caller identity comes from tool context, cannot be supplied by parameters, survives same-session resume, and differs for a new session. They also prove creator/completer provenance does not restrict pending edits, dependency changes, or reopen by another authorized session, while assignment protects in-progress mutations.
9. Lifecycle tests prove only explicit Task-tool calls change `pending`, `in_progress`, and `completed` state.
10. Negative lifecycle tests prove process exit, session end, subagent events, tool errors, and unrelated extension events do not complete, release, or reopen tasks.
11. Dependency tests cover authorization through tool availability, pending/unassigned state enforcement, one-edge mutations, missing endpoints, duplicate edges, self-edges, cycles, dangling legacy edges, and ready-set changes after blocker completion. Tests prove in-progress and completed graph mutations fail without changing state.
12. Reopen tests prove task identity and history remain stable.
13. Completion tests prove an owned task can close with or without an optional completion note and that unowned callers cannot close claimed work. Schema tests enforce per-action field combinations, inherited edit limits, note/reason/reference limits and formats, pagination limits, stable error codes, exact bounded payloads, per-history-event bytes, total history bytes, total tool-result bytes, and digest/reference truncation.
14. Listing tests prove ready, blocked, in-progress, completed, owner, and current-caller projections derive from Beads data.
15. Widget tests prove UI counts and active-task display are read-only projections and cannot mutate task state.
16. Timeout tests prove unavailable Beads operations return bounded structured errors rather than hanging the session.
17. Prompt tests prove Task-tool descriptions contain lifecycle guidance without mode-specific, delegation-specific, Worker, or Reviewer instructions.
18. Migration fixtures cover project, shared, and session stores; memory/off modes; all task states; allowlisted and execution-only metadata; oversized historical results; valid DAGs; duplicate/self/cyclic/dangling/asymmetric edges; ID collisions; and corrupt files. Legacy `in_progress` fixtures must emerge as `pending` and unassigned with provenance; oversized text must use digest/reference truncation.
19. Dry-run tests prove no mutation occurs and the artifact contains complete mappings, source digests, unsupported records, operations, and parity results.
20. Import tests prove deterministic direct task mapping, idempotent replay, field conversion, dependency conversion, and explicit unsupported-record handling.
21. Cutover tests prove source-digest changes abort, dual writers never run, smoke failure blocks release, and only the Task backend changes.
22. Rollback tests prove Beads writers stop before legacy activation and untouched snapshots restore matching counts and ready sets.
23. Upgrade tests prove incompatible Beads versions or schemas fail before mutation and only designated migration operations alter schema.
24. Existing TaskCreate, TaskList, TaskGet, TaskUpdate, store, DAG, rendering, and widget tests provide prior art. Task-extension execution, subagent-bridge, task-runner, and auto-cascade tests are retired with the removed behavior. Outer-extension behavior and prompt tests remain unchanged.
25. A static compatibility test proves no outer extension source or prompt invokes or instructs use of removed Task execution tools or Task RPC channels. Launch also requires zero implicit lifecycle transitions, zero duplicate successful claims, zero unbounded task calls/results, no Task-extension dependency on outer extensions, and parity for every supported migrated record.

## Out of Scope

- Spawning, supervising, steering, stopping, or collecting output from agents.
- `TaskExecute`, `TaskOutput`, `TaskStop`, background-process management, or automatic task execution.
- Changes to the subagent, modes, Handoff, multimodal, PM marketplace, or other outer extensions.
- Fu Xi/Houtu-specific PLAN conversion, planning-task cleanup, or mode-specific tool policy.
- Worker, Reviewer, coordinator, or main-orchestrator roles inside Task Tools.
- Execution bindings, attempts, generations, stale-result fencing, runtime reconciliation, or execution recovery.
- Submission, review, approval, evidence-gating, or `awaiting_review` workflow.
- Automatic completion, failure handling, retry policy, or release based on runtime events.
- Mandatory epics, session-to-epic binding, cross-epic policy, or epic lifecycle management.
- File/path scopes, worktrees, merge orchestration, or shared-working-directory safety.
- Raw `bd`, Dolt SQL, arbitrary Beads administration, or `beads-mcp` exposure to agents.
- Cross-project federation, Beads messaging, swarm orchestration, formulas, gates, deployment policy, financial approval, or human-interaction workflows.
- Automatic external communication or destructive side effects.
- Treating migrated legacy completion as newly verified work.
- Deleting rollback data during initial migration.
- Directed claim of a named task until Beads offers one atomic named readiness-and-claim operation.

## Further Notes

The design intentionally makes Task Tools a deep module: agents learn one small task-management interface while Beads storage, readiness, concurrency, migration, and error handling stay behind it.

The deletion test is explicit. If the Task extension were removed, agents would lose task management; no execution, delegation, review, mode, or Handoff behavior would disappear with it.

Outer workflows may mention generic Task tools in their prompts, but they receive no private integration. They call the same registered interface as any other authorized agent.

The Open Design walkthrough created for the earlier orchestration design is stale after this rewrite and should not be treated as v3 source material until regenerated.

Relevant upstream references:

- [Beads README and storage modes](https://github.com/gastownhall/beads/blob/main/README.md)
- [Beads CLI reference](https://github.com/gastownhall/beads/blob/main/docs/CLI_REFERENCE.md)
- [Beads setup and agent integrations](https://github.com/gastownhall/beads/blob/main/docs/SETUP.md)
- [Beads troubleshooting](https://github.com/gastownhall/beads/blob/main/docs/TROUBLESHOOTING.md)
