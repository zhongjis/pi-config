# Awaited Dynamic Agent-Graph Expansion — Implementation Plan

Status: completed

Contract: [../specs/dynamic-agent-graph-expansion.md](../specs/dynamic-agent-graph-expansion.md)

## Goal

Ship the `fanout` node, dynamic monitor registration, and a two-round `shared/context-gather` that creates only requested research children. Preserve `expand`, existing graph callers, partial evidence, and fresh Subagent execution.

## 1. Lock the Runtime Contract

Files:

- `extensions/subagents/src/graph/ir.ts`
- `extensions/subagents/src/graph/validate.ts`
- `extensions/subagents/src/graph/delegation-preflight.ts`
- `extensions/subagents/test/graph-validate.test.ts`
- `extensions/subagents/test/graph-delegation-preflight.test.ts`

Changes:

1. Add `FanoutNode`, `FanoutPhase`, dispatch types, and `fanout` to `GraphNode`/`NODE_TYPES`.
2. Validate item/output schemas, ValueRefs, dispatch cases, `${item}`, phase metadata, and the no-loop-target rule.
3. Include every dispatch-case selector in delegation preflight.
4. Add focused validation and preflight tests before runtime work.

Completion: valid fanouts pass, malformed fanouts fail with locating messages, and denied generated selectors reject before execution.

## 2. Implement Awaited All-Settled Fanout

Files:

- `extensions/subagents/src/graph/scheduler.ts`
- `extensions/subagents/src/graph/run-graph.ts`
- `extensions/subagents/test/graph-fanout.test.ts`
- `extensions/subagents/test/graph-controls.test.ts`
- `extensions/subagents/test/graph-scheduler.test.ts`

Changes:

1. Track collection ownership and attempt reason in scheduler state.
2. Materialize a fanout atomically after resolving and validating every item and selector.
3. Generate deterministic `<fanout-id>:item:<index>` agent nodes, use the normal agent launch path, and exclude the running barrier from concurrency accounting.
4. Settle the parent only after all children are terminal; preserve input order in `{ results }`.
5. Keep child failures visible but exclude collected failures from overall graph failure.
6. Append dynamic IDs to the control index so pause/skip/retry semantics remain stable.
7. Record `user-retry` versus `loop` attempt reasons.

Completion: empty, successful, mixed-failure, invalid, overflow, control, and second-source cases pass without changing legacy `expand` behavior.

## 3. Persist Effective Dynamic Topology

Files:

- `extensions/subagents/src/graph/run-graph.ts`
- `extensions/subagents/src/graph/graph-persist.ts`
- `extensions/subagents/src/graph/workflow-runtime.ts`
- `extensions/subagents/test/graph-persist.test.ts`
- `extensions/subagents/test/graph-persist-io.test.ts`
- `extensions/subagents/test/graph-durable-resume.test.ts`

Changes:

1. Expose the effective graph with gate-waiting snapshots.
2. Persist generated definitions and additive collection state in the existing snapshot envelope.
3. Restore collection ownership, retain settled children, reset interrupted children, and reattach the fanout parent without duplicate insertion.
4. Keep version-1 snapshots without collection metadata readable.

Completion: a checkpoint during an active fanout restores the same IDs and reruns only interrupted children.

## 4. Register Dynamic Nodes in Herdr

Files:

- `extensions/subagents/src/graph/run-graph.ts`
- `extensions/subagents/src/graph/graph-run-adapter.ts`
- `extensions/subagents/src/graph/progress.ts`
- `extensions/subagents/src/graph/entry-validation.ts`
- `extensions/subagents/src/ui/observability-panel.ts`
- `extensions/subagents/src/ui/workflow-dialog.ts`
- `extensions/subagents/test/graph-run-adapter.test.ts`
- `extensions/subagents/test/observability-panel.test.ts`
- `extensions/subagents/test/workflow-dialog.test.ts`

Changes:

1. Emit `onNodeAdded` before a generated node's first update.
2. Add `GraphRunReporter.registerNode` with monotonic indices, selector/prompt, display dependencies, dependent links, and inherited phase metadata.
3. Propagate attempt reason through progress/history validation.
4. Render round titles and `attempt N` with `user retry` or `loop` in the panel and dialog.
5. Preserve current width, privacy, and conversation-record behavior.

Completion: dynamic rows appear once, in the correct round, with unique indices, effective model/record metadata, and distinct retry reasons.

## 5. Replace Static Context Lanes

Files:

- `agent-graphs/shared/context-gather.graph.json`
- `extensions/subagents/test/graph-portfolio.test.ts`
- `agent-graphs/fuxi/ulw-plan.graph.json` (verify only unless contract drift is found)
- `agent-graphs/kuafu/ulw.graph.json` (verify only unless contract drift is found)

Changes:

1. Replace the router and ten predefined lanes with two explicit fanout nodes, two evaluators, and one synthesizer.
2. Keep caller input `{ request, tasks }` and the existing `GatheredContext` outputs.
3. Make evaluators return only `{ sufficient, gaps, tasks }` and consume all-settled evidence.
4. Route round two only when round one is insufficient; allow any supported source in round two.
5. Keep source mapping `project -> chengfeng`, all external sources -> `wenchang`.

Completion: portfolio assertions prove two fanouts, no predefined source lane nodes, structural two-round bound, preserved outputs, and unchanged caller wiring.

## 6. Publish Authoring Guidance and Contracts

Files:

- `extensions/subagents/skills/agent-graphs/SKILL.md`
- `extensions/subagents/skills/agent-graphs/references/dynamic-expansion.md`
- `docs/specs/agent-graph-reusable-workflows.md`
- `docs/specs/graph-run-monitor.md`
- `docs/README.md`
- `extensions/subagents/AGENTS.md`
- `agent-graphs/AGENTS.md`

Changes:

1. Add a compact Dynamic expansion section to the skill and point detailed cases to the new reference.
2. Cover when to use fanout, typed tasks, awaited completion, per-round namespaces, bounded evaluation rounds, and output/failure collection in the reference.
3. Reconcile the portfolio and monitor specs with shipped dynamic behavior.
4. Update DOX contracts and indexes only where ownership or behavior changed.

Completion: no doc describes static context source lanes, and graph authors can find the fanout contract without loading the full reference on every task.

## 7. Verification

Run from the repository root unless noted:

```bash
pnpm exec vitest run --project unit \
  extensions/subagents/test/graph-validate.test.ts \
  extensions/subagents/test/graph-delegation-preflight.test.ts \
  extensions/subagents/test/graph-fanout.test.ts \
  extensions/subagents/test/graph-controls.test.ts \
  extensions/subagents/test/graph-scheduler.test.ts \
  extensions/subagents/test/graph-persist.test.ts \
  extensions/subagents/test/graph-persist-io.test.ts \
  extensions/subagents/test/graph-durable-resume.test.ts \
  extensions/subagents/test/graph-run-adapter.test.ts \
  extensions/subagents/test/observability-panel.test.ts \
  extensions/subagents/test/workflow-dialog.test.ts \
  extensions/subagents/test/graph-portfolio.test.ts
pnpm lint:typecheck
git diff --check
```

Then start a fresh Pi session through `interactive_shell` and run `shared/context-gather` with one round-one project task designed to leave an external gap. Confirm:

- round one creates only that project child;
- the evaluator adds only gap-closing round-two children;
- Herdr shows `Round 1/2` and `Round 2/2` with unique rows and records;
- no unused source nodes appear;
- the workflow completes with all `GatheredContext` fields.

Record the workflow ID and node counts in the final delivery.

## Verification Result

- `pnpm exec vitest run --project unit extensions/subagents/test` — 1,196 passed.
- Root and `extensions/second-opinion` TypeScript checks passed.
- `git diff --check` passed.
- Fresh Pi workflow `wf_046ae6090b22` completed with nine visible nodes: one requested round-one child, three evaluator-authored round-two children, two evaluators, two fanout barriers, and synthesis.
- The live result contained `summary`, `relevantFiles`, `constraints`, `unknowns`, provenance-bearing `evidence`, and `conflicts`; no unused source-lane nodes appeared.
