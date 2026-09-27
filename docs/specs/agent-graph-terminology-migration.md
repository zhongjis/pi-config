# Retire the "workflow" Terminology in the Subagents Extension

Status: shipped

Owner: docs/AGENTS.md (specs bucket)

Related: [../../extensions/subagents/CONTEXT.md](../../extensions/subagents/CONTEXT.md) (glossary) · [../../CONTEXT-MAP.md](../../CONTEXT-MAP.md) · [ADR 0002 — remove SubagentWorkflow script runtime](../adr/0002-remove-subagentworkflow-script-runtime.md) · [workflow-tool-output-presentation.md](workflow-tool-output-presentation.md) · [herdr-agent-graph-presentation.md](herdr-agent-graph-presentation.md)

ADR 0003 records completion of this migration. The detailed design below is implementation history, not a current inventory of old names or paths. Its proposed legacy-key warning and warning test were superseded: installed configs use `agentGraphEnabled`, and the hard rename has no compatibility handling.

## Problem Statement

As a maintainer of the subagents extension, I read the same agent-graph feature named two different ways — "graph" and "workflow" — and cannot tell whether they mean different things. They do not: "workflow" is dead residue from the `SubagentWorkflow` script runtime that ADR 0002 removed, but it still lives in roughly 1,261 places across the extension — file names, ~60 exported identifiers, user-facing strings, and a handful of persisted contract identifiers.

At the time of the audit, readers and users encountered:

- The same run roster is labelled "Graph runs" in the parent menu and slash command, but "Workflows" in the selector, tool description, notifications, and outcome key — often two lines apart.
- Settings still describe the feature as "scripted subagent orchestration" and a child prompt still injects "a workflow script", even though the script runtime is gone.
- The README documents an `agent_graph` `name` parameter and a "`graph` → `name`" precedence that the tool does not have; the authoring skill claims the completion status shows "Workflow outcome …" wording the code never emits.
- Every new contributor must re-learn which of the two words is load-bearing.

## Solution

Adopt the already-committed glossary (`extensions/subagents/CONTEXT.md`) as the single vocabulary and remove "workflow" from the extension. "Agent graph" names the declarative data structure; "agent graph run" names one execution (short form "graph run" is sanctioned inside code); "workflow" is retired.

Concretely:

- Rename internal run/host/UI identifiers to the `GraphRun*` family that the engine already uses, keeping `AgentGraph` for the data structure.
- Hard-rename the persisted/contract identifiers with **no back-compatibility shim** (config key, graph output key, artifact suffix, session type, run-id prefix). Only the `agent_graph` tool name is permanently frozen.
- The original migration included a one-time stderr warning for the legacy `workflowsEnabled` key. That warning was later removed; current settings read only `agentGraphEnabled`, with no compatibility handling.
- Fix the two documentation bugs uncovered during the audit.

The original migration plan treated the warning as its only behavior change and divided the work into ordered waves. The warning was subsequently removed; the wave plan below is historical.

## User Stories

1. As an extension maintainer, I want one canonical term for the agent-graph feature, so that I stop second-guessing whether "graph" and "workflow" differ.
2. As a maintainer reading `src/graph/`, I want run/host/UI identifiers to use one `GraphRun*` family, so that I can navigate without a mental translation table.
3. As a maintainer, I want `AgentGraph` to keep meaning only the data structure, so that "the spec" and "a run" never collide in a type name.
4. As a Pi end user opening the run monitor, I want every surface to say "Graph runs", so that the selector, menu, and empty-state agree.
5. As a Pi end user, I want completion notifications and cards to never say "workflow", so that the wording matches the `agent_graph` tool I invoked.
6. As a Pi end user, I want the settings entry to describe the feature accurately, so that I am not told it is "scripted" orchestration that no longer exists.
7. As a graph author, I want the reserved output key to read `$agentGraphOutcome`, so that the key name matches the feature I am authoring for.
8. As a graph author, I want the authoring skill and README to describe the real `agent_graph` parameters, so that I do not pass a `name` argument that silently does nothing.
9. As a graph author, I want the saved graphs in `agent-graphs/` updated to the new outcome key in lockstep, so that shipped graphs keep declaring outcomes.
10. Original migration story (superseded): warn on stale `workflowsEnabled` rather than silently disable the feature. Current configuration requires `agentGraphEnabled`; no warning or fallback remains.
11. As a maintainer, I want the completion artifact suffix to read `.graph-result.txt`, so that on-disk artifacts match the vocabulary.
12. As a maintainer, I want the session entry type and in-memory run discriminator renamed off "workflow", so that persisted records and the fleet view use consistent terms.
13. As a maintainer, I want the run-id prefix to read `agr_`, so that a run identifier visibly denotes an agent graph run.
14. As a maintainer, I want the retired-term references in code comments (e.g. the stale `--subagents-workflow-file` mention) removed, so that comments stop describing a script runtime that no longer exists.
15. As a reviewer, I want each wave to be an atomic commit with a green `tsc` + test run, so that I can review and bisect the migration in stages.
16. As a reviewer, I want the highest-risk contract renames isolated in their own commit, so that a rollback does not also revert safe cosmetic changes.
17. As a maintainer, I want a drain preflight before the run-id rename, so that renaming `wf_`→`agr_` does not silently strand in-flight resumable runs.
18. As a maintainer, I want an ADR recording the hard-rename decision, so that a future reader understands why old snapshots/sessions were intentionally orphaned.
19. As a maintainer, I want the docs, AGENTS.md files, SKILL, and adjacent specs aligned to the new terms, so that documentation stops teaching the retired word.
20. As a maintainer, I want `rg -i workflow extensions/subagents/{src,test}` to return nothing after the migration, so that I have a mechanical completeness check.
21. As a Pi end user resuming a session, I want the renamed run monitor and cards to keep functioning, so that the migration does not degrade the live experience.
22. As a graph author with an out-of-repo saved graph, I want the retired outcome key documented in the ADR, so that I know to update my own graphs.

## Implementation Decisions

**Naming scheme (Default; the "uniform" alternative of renaming the engine's existing `GraphRun*` was rejected as scope creep).**

| Population | Old | New |
|---|---|---|
| in-memory run record | `WorkflowTask` (`type: "local_workflow"`) | `GraphRunTask` (`type: "local_graph_run"`) |
| run types/functions | `WorkflowRunResult`, `WorkflowMeta`, `WorkflowControl`, `WorkflowOutcome`, `WorkflowRunStatus`, `WorkflowEntry*`, `WorkflowRun`, `HistoricalWorkflow`, `createWorkflowRuntime`, `mergeWorkflowRuns`, `formatWorkflowNotification`, … | `GraphRunResult`, `GraphRunMeta`, `GraphRunControl`, `GraphRunOutcome`, `GraphRunStatus`, `GraphRunEntry*`, `GraphRun`, `HistoricalGraphRun`, `createGraphRuntime`, `mergeGraphRuns`, `formatGraphRunNotification`, … |
| UI types/components | `WorkflowCard*`, `WorkflowDialog*`, `WorkflowPane*`, `WorkflowMenuDeps`, `FleetWorkflow`, `showWorkflowsMenu` | `GraphRunCard*`, `GraphRunDialog*`, `GraphRunPane*`, `GraphRunMenuDeps`, `FleetGraphRun`, `showGraphRunsMenu` |
| data structure | `AgentGraph` | unchanged |
| config key (contract) | `workflowsEnabled` / `setWorkflowsEnabled` | `agentGraphEnabled` / `setAgentGraphEnabled` |
| output key (contract) | `$subagentWorkflowOutcome` / `WORKFLOW_OUTCOME_KEY` | `$agentGraphOutcome` / `GRAPH_OUTCOME_KEY` (type `GraphRunOutcome`) |
| artifact suffix (contract) | `.workflow-result.txt` | `.graph-result.txt` |
| session type (contract) | `subagents:workflow` / `WORKFLOW_ENTRY_TYPE` | `subagents:graph-run` / `GRAPH_RUN_ENTRY_TYPE` |
| run-id prefix (contract) | `wf_` + `^wf_[a-z0-9-]{6,}$` / `isWorkflowRunId` | `agr_` + `^agr_[a-z0-9-]{6,}$` / `isGraphRunId` |
| file names | `graph/workflow-runtime.ts`, `graph/workflow-types.ts`, `ui/workflow-{card,dialog,menu,report}.ts`, `test/workflow-*.ts` | `graph/graph-runtime.ts`, `graph/graph-run-types.ts`, `ui/graph-run-{card,dialog,menu,report}.ts`, `test/graph-run-*.ts` |

- The `agentGraph*` (contracts) / `GraphRun*` (code) split is intentional and mirrors the glossary: prose/contract surfaces use the fuller "agent graph", in-context code uses "graph run". A comment ties the `$agentGraphOutcome` key to the `GraphRunOutcome` type at the constant.

**Modules modified:** the graph runtime/host layer, the run-monitor UI layer, the settings module and its menu, the completion-notification/artifact writer, the session-entry type, the run-id/snapshot-path helper, the saved graphs in `agent-graphs/`, and the docs (README, AGENTS.md files, authoring SKILL, adjacent specs, CHANGELOG).

**Superseded warning design:** the migration initially warned once for `workflowsEnabled` without enabling the feature. That warning was removed. Only `agentGraphEnabled` governs registration; a stale key neither enables the feature nor triggers compatibility handling.

**Dead `SubagentWorkflow` fields (deferred, out of scope):** the `script`/`scriptPath` fields are script-runtime residue, but `scriptPath` is part of the persisted, restore-validated session-entry shape (`WorkflowEntryData` and its validation schema), so removing them is a persisted-shape change unrelated to terminology. It is deferred to a separate dead-code pass rather than bundled into this rename; only their names, if they contained "workflow", would move (they do not).

**Wave structure (each an atomic commit; green `tsc --noEmit` + `vitest run` + biome on changed files before the next):**

- Wave 1 — user-facing strings + the two doc bugs. No identifier or contract change.
- Wave 2 — internal identifier renames + file/test renames (history-preserving moves). Compiler-gated.
- Wave 3a — config-key rename (+ repo config + root AGENTS.md) + the legacy-key stderr warning (later removed).
- Wave 3b — persisted run identity (run-id prefix + regex, session customType, in-memory discriminator, the persisted progress-entry discriminators `workflow_phase`/`workflow_log`/`workflow_agent`, the `WorkflowEntryData` session-entry type, the output key in lockstep with the saved graphs and SKILL, and the artifact suffix). Preceded by a drain preflight that guarantees no `wf_` snapshots or session references remain in the run-snapshot directory.
- Wave 4 — docs/AGENTS/SKILL/adjacent-specs alignment + CHANGELOG + a new ADR recording the hard-rename decision and the accepted orphaning of old snapshots/sessions.

**Contract migration policy:** hard rename, no back-compat. Old `wf_` snapshots and `subagents:workflow`/`local_workflow` session entries become unrecognized after the rename; by existing design they are ignored-if-foreign, so they orphan harmlessly rather than crash. The migration is performed on a clean slate (no live agent graph runs, drained checkpoints).

## Testing Decisions

- **Seam (single, highest point):** the existing vitest suites are the characterization harness. A rename is behavior-preserving, so the contract is that the full `vitest run` and `tsc --noEmit` stay green through every wave. No new seams are introduced. A good test here asserts external behavior (registration gating, notification content, presentation output, snapshot round-trips), not identifier spelling.
- **Superseded warning test:** the original plan called for a settings-read test asserting one warning for a stale `workflowsEnabled` key. That warning is no longer current behavior; enabled-only tool-registration tests remain relevant.
- **Prior art for the rename characterization:** the notification-content, presentation, pane-render, and durable-resume suites already pin the observable behavior these renames must preserve.
- **Manual QA (Wave 3):** a fresh Pi session (per the extension AGENTS.md verification rule) runs a saved agent graph through `agent_graph`, and the run is inspected end-to-end — tool call, monitor labelling ("Graph runs", no "workflow"), completion notification wording, the `$agentGraphOutcome` flow, and the `.graph-result.txt` artifact.
- **Completeness check:** review every `rg -i workflow extensions/subagents/{src,test}` match; permit only explicit historical comparisons, external `.github/workflows/` paths, and negative regression assertions.

## Out of Scope

- The `agent_graph` tool name — permanently frozen.
- The "uniform" naming variant (renaming the engine's existing `GraphRun*`/`Graph*` identifiers to `AgentGraphRun*`); those were never "workflow" terms.
- Other behavior changes beyond the terminology migration; the originally planned legacy-key warning was later removed.
- Migrating or rewriting existing on-disk snapshots/session records — they are intentionally orphaned on a clean slate.
- Anything outside `extensions/subagents/`, its saved graphs in `agent-graphs/`, and the directly-owned docs.
- Removing the dead `script`/`scriptPath` fields — deferred to a separate dead-code pass (they are not "workflow"-named, and `scriptPath` is a persisted, restore-validated shape).
- The unrelated `workflow`/CI matches in `CHANGELOG.md` history (GitHub Actions "workflow"), which are not this feature.

## Further Notes

- This spec was reviewed with a read-only architecture consult (taishang), which endorsed the Default naming, flagged the silent-feature-disable risk (initially addressed by the now-removed legacy-key warning), recommended splitting Wave 3 into 3a/3b, and advised a drain preflight for the run-id rename.
- `local_workflow` and the `wf_` prefix were verified to be extension-internal: the pinned Pi runtime has no references to them, so renaming them does not break a host/renderer contract.
- Estimated effort ~2 days; the schedule risk is the two verification gates (drain preflight, serialization confirm), not the renames themselves.
