# 3. Retire the "workflow" terminology in the subagents extension

Status: shipped
Date: 2026
Related: [../specs/agent-graph-terminology-migration.md](../specs/agent-graph-terminology-migration.md) · [../../extensions/subagents/CONTEXT.md](../../extensions/subagents/CONTEXT.md) · [0002-remove-subagentworkflow-script-runtime.md](0002-remove-subagentworkflow-script-runtime.md)

## Context

[ADR 0002](0002-remove-subagentworkflow-script-runtime.md) removed the `SubagentWorkflow` script runtime and made the typed `agent_graph` tool the single execution path. The old "workflow" vocabulary was left behind as residue: it survived in ~1,261 places across the extension — file names, ~60 exported identifiers, user-facing strings, and a set of persisted/contract identifiers — while the load-bearing contracts (`agent_graph`, the `graph` parameter, the `agent-graphs` skill, `.graph.json`, the `graph-*` engine) were named "graph". The same run roster was labelled "Graph runs" in one menu and "Workflows" two lines away; the README documented a nonexistent `name` parameter; the settings still called the feature "scripted".

The committed glossary ([`extensions/subagents/CONTEXT.md`](../../extensions/subagents/CONTEXT.md)) makes the canonical terms **agent graph** (the data structure), **agent graph run** (one execution, short form "graph run" in code), and retires **workflow**. Only `agent_graph` (the tool name) is permanently frozen.

## Decision

Rename the internal run/host/UI identifier family from `Workflow*` to the engine's existing `GraphRun*` family, keeping `AgentGraph` for the data structure, and **hard-rename the persisted/contract identifiers with no back-compatibility shim**:

- config key `workflowsEnabled` → `agentGraphEnabled`
- reserved output key `$subagentWorkflowOutcome` → `$agentGraphOutcome` (in lockstep with the saved graphs and the authoring skill)
- run-id prefix `wf_` → `agr_` (+ `^agr_` regex)
- session customType `subagents:workflow` → `subagents:graph-run`, in-memory discriminator `local_workflow` → `local_graph_run`, persisted progress discriminators `workflow_phase|log|agent` → `graph_run_*`
- entry shape `WorkflowEntryData` → `GraphRunEntryData`
- artifact suffix `.workflow-result.txt` → `.graph-result.txt`

Two guardrails accompanied the hard rename:

1. **Config migration.** At the time of the rename, `loadSettings` warned once when it read a legacy `workflowsEnabled` key; that warning was subsequently removed after installed configs moved to `agentGraphEnabled`. The shipped key is `agentGraphEnabled`, with no legacy compatibility handling.
2. **Clean-slate migration.** Old `wf_` snapshots and `subagents:workflow` session entries became unrecognized after the rename; by existing design they are ignored-if-foreign, so they orphan harmlessly. The migration was performed with no live runs and the snapshot directory drained.

## Consequences

- One vocabulary. Current extension code and tests use graph terminology; the legacy-key warning is no longer retained.
- **Breaking for stale config and out-of-repo state.** A config file still using `workflowsEnabled` no longer enables the feature and must be renamed to `agentGraphEnabled`; no compatibility warning or fallback remains. The deployed `~/.pi/agent/subagents.json` is a symlink to the repo file, so it moves in lockstep. Out-of-repo saved graphs must update the reserved outcome key. Pre-migration on-disk snapshots and session entries are intentionally abandoned.
- The rename is otherwise behavior-preserving: `tsc` clean and the full test suite unchanged at its pre-existing failure baseline across every wave.
- The "uniform" alternative (also renaming the engine's existing `GraphRun*` to `AgentGraphRun*`) was rejected as scope creep over clean, non-workflow code.
