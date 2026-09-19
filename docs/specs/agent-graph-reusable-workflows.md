# Reusable Agent-Graph Workflow Portfolio

Status: draft

Owner: docs/AGENTS.md (specs bucket)

Related: [../ideas/agent-graph-design-v2.md](../ideas/agent-graph-design-v2.md) §2 · [../guides/agent-graph-implementation.md](../guides/agent-graph-implementation.md) · authoring skill `extensions/subagents/skills/agent-graphs/SKILL.md`

## Problem Statement

The typed `agent_graph` runtime shipped (design §1), but nothing durable exercises it.
Multi-agent work in this harness is still expressed as ad-hoc `Agent` calls or the
legacy `SubagentWorkflow` scripts. As a graph author I have no proven, reusable
graphs to start from, no evidence the runtime survives real composite runs
(subgraphs, human gates, bounded loops, dynamic expansion, resource scheduling),
and no confidence that authoring mistakes surface before a run burns tokens.

Concretely:

- I cannot point Pi at a saved workflow for the three recurring shapes — gather
  context, review-and-iterate, verify work — so every flow re-invents them.
- I have no end-to-end proof that a graph composed of subgraphs plus a human gate
  plus a bounded review loop runs to completion under the real
  `AgentManager`-backed host.
- A silent authoring hazard exists: an unmapped `${placeholder}` in a prompt stays
  literal with no error, so a mis-wired graph runs anyway and produces garbage.
- Nothing gates the legacy script-runtime removal (design §2.8) because no
  reusable-workflow parity existed to replace it.

## Solution

Ship a small, composable portfolio of **saved agent graphs** that both (a) give Pi
reusable building blocks for planning, implementation, and verification, and (b)
serve as the production stress-test that hardens the runtime before cutover.

The portfolio is three shared subgraphs and three mode-facing flows:

```
shared/context-gather   shared/review-loop   shared/work-verify
        ^      ^                                    ^
        |      |                                    |
   fuxi/ulw-plan   kuafu/ulw ---- dynamic work graph |
        |                                            |
   review loop                                 shared/work-verify
```

Each flow is plain version-controlled JSON under `agent-graphs/`, validated
before any node runs. Authoring hazards are turned into validation errors so a
mis-wired graph fails at the tool call, not mid-run. Once the portfolio runs
end-to-end, the reusable-workflow parity it establishes unblocks removing the
legacy script runtime (design §2.8 deferral is superseded).

## User Stories

1. As a graph author, I want three shared subgraphs (`shared/context-gather`,
   `shared/review-loop`, `shared/work-verify`), so that I can compose flows instead
   of re-authoring the same shapes.
2. As a graph author, I want `shared/context-gather` to route caller-planned
   source tasks on demand and synthesize one typed `GatheredContext`, so that
   planning and implementation flows share an evidence format without static lanes.
3. As a graph author, I want `shared/review-loop` to review an artifact and iterate
   revise→review until approved or a bounded cap, so that I get bounded critique
   without an unbounded loop.
4. As a graph author, I want `shared/work-verify` to run deterministic gates and a
   model review in parallel and summarize, so that a verification result separates
   deterministic failures from review concerns.
5. As Fu Xi (plan mode), I want one public `fuxi/ulw-plan` flow that gathers
   context, intakes requirements, clarifies via a human gate only when unclear,
   authors a plan, runs gap analysis, and review-loops the plan, so that planning
   is one durable transaction rather than several manual handoffs.
6. As a planner, I want the human clarification gate to be skipped when the request
   is already clear, so that a clear request plans fully automatically and only an
   unclear one pauses for a human.
7. As Hou Tu (execute mode), I want `houtu/execute-plan` to parse and validate a
   plan, turn it into a `GraphFragment`, expand it into a concrete implementation
   graph at runtime, then verify, so that implementation topology comes from the
   plan and not from hard-coded workflow structure.
8. As Kua Fu (build mode), I want `kuafu/ulw` to gather context, classify the work,
   route simple work to a direct agent and complex work to a dynamically expanded
   work graph, then verify, so that the caller need not pre-decide how many agents
   a request deserves.
9. As a graph author, I want an unmapped `${placeholder}` to be a validation error
   naming the node and the placeholder, so that a mis-wired prompt fails before the
   run instead of silently sending literal `${x}` to an agent.
10. As a graph author, I want every portfolio graph to pass `validateGraph` on the
    first run, so that the shipped graphs are known-good starting points.
11. As an operator, I want each portfolio graph to run under the real
    `AgentManager` host and appear in `/agents → Workflows` grouped by stage, so
    that I can watch and control (pause/skip/retry) a live run.
12. As an operator, I want at least one composite flow to complete end-to-end with
    a captured outcome, so that "the runtime works" is evidence, not assertion.
13. As a graph author, I want subgraph inputs/outputs namespaced and typed, so that
    composing `shared/*` inside a flow does not leak or collide node ids.
14. As a graph author, I want conditional edges to route on validated structured
    output (never agent prose), so that branching is deterministic and inspectable.
15. As a graph author, I want bounded loops to require an explicit `loop` cap on any
    cycle-closing edge, so that a review loop can never run forever.
16. As a graph author, I want a proven ad-hoc graph promotable to a saved
    `agent-graphs/shared/<name>.graph.json` without rewrite, so that successful
    structures become reusable workflows.
17. As a maintainer, I want the portfolio documented as a spec with a testing
    strategy, so that future edits have a contract to check against.
18. As a maintainer, I want the reusable-workflow parity to explicitly unblock the
    §2.8 legacy-runtime removal, so that the cutover has a recorded justification.

## Implementation Decisions

### Portfolio and storage

- Six saved graphs live under `agent-graphs/`, namespaced by `/`:
  `shared/context-gather`, `shared/review-loop`, `shared/work-verify`,
  `fuxi/ulw-plan`, `houtu/execute-plan`, `kuafu/ulw`. Each is a standalone
  `<name>.graph.json` holding an `AgentGraph`.
- Graphs reference real agents by selector: planning/analysis via `chengfeng`,
  `wenchang`, `taishang`, `direnjie`, `xuannv`; implementation via `jintong`,
  `juling`, `guangguang`; review via `yanluo`; docs via `cangjie`. Unknown
  selectors fall back to `general-purpose`, but the portfolio uses known ones.

### `shared/context-gather`

- Requires `{ request, tasks }`; each caller task names one of `project`, `platform`,
  `upstream`, `work-records`, or `practice` plus a question. Callers check applicable
  Skills before creating tasks; this graph never adds practice research by default.
- A router groups supplied tasks into five conditional, batched source lanes: `project`
  uses `chengfeng`; the other sources use `wenchang`. A loose evaluator compares
  request, tasks, and evidence, then may route one gap-closing second round only.
- Each lane returns provenance-bearing evidence plus relevant files, constraints, unknowns,
  and conflicts. Failed or skipped optional lanes leave unresolved evidence, not failure.
- `synthesize` returns `summary`, `relevantFiles`, `constraints`, `unknowns`, `evidence`,
  and `conflicts`; graph outputs expose this compatible extended `GatheredContext`.

### `shared/review-loop`

- Generic review→revise cycle over an artifact string plus task context.
- `review` (`yanluo`) returns `{ approved: boolean, issues: string[] }`.
- A `when: approved == true` edge routes to `done`; `approved == false` routes to
  `revise`; a `revise → review` edge carries `loop: { maxIterations: 3 }`.
- The artifact is passed as an input value, not hard-coded to one type.

### `shared/work-verify`

- Parallel verification lanes over an implementation summary: `tests` and
  `static-check` are `agent` nodes carrying a `validation.gate` shell command
  (deterministic), and `review` (`yanluo`) is a model check.
- `summarize` joins them into
  `{ deterministicPass: boolean, reviewApproved: boolean, concerns: string[] }`,
  distinguishing deterministic failures from review concerns.

### `fuxi/ulw-plan`

- One public planning flow requires `{ request, tasks }`, forwards both to
  `shared/context-gather`, then runs `intake` → optional `clarify` (`human_gate`, reached
  only on `intake.clear == false`) → `plan-author` → `gap-analysis` → `review`
  (`graph: shared/review-loop` over the plan) → `plan`.
- `intake` emits `{ clear: boolean, requirements: string[] }`. The `clarify` gate
  is on the `clear == false` branch only, so a clear request skips it and plans
  automatically; `plan-author` joins the clear edge and the clarify edge.
- Proves: subgraph composition, parallel analysis (inside context-gather),
  conditions, a human gate, typed output, and a bounded review loop.

### `houtu/execute-plan`

- `parse-plan` → `validate-plan` → `plan-to-graph` (emits a `GraphFragment` as
  typed output) → `expand` (splices the fragment under a namespace) →
  `verify` (`graph: shared/work-verify`) → `result`.
- `plan-to-graph` returns `{ fragment: GraphFragment }`; the `expand` node's
  `source` is a `ValueRef` at `$.fragment`. The runtime validates the fragment
  (`validateFragment`) against existing ids before insertion.
- Task nodes in the fragment carry `resources` (e.g. `workspace:main`) so the
  scheduler serializes writers to a shared workspace; distinct worktree resources
  would allow parallelism.
- Proves: runtime graph expansion, fragment validation, dependency + resource
  scheduling, subgraph verification, monitoring of dynamically added nodes.

### `kuafu/ulw`

- `context` (`graph: shared/context-gather`) → `classify` →
  branch on `classify.complexity`: `simple` → `direct-work` (`agent`), `complex` →
  `design-work-graph` (emits a `GraphFragment`) → `expand` → both branches join at
  `verify` (`graph: shared/work-verify`) → `result`.
- `classify` emits `{ complexity: "simple" | "complex" }`; conditional edges route
  on it. `verify` joins whichever branch fired.
- Proves: classification/routing on typed output, dynamic expansion for the complex
  path, and shared verification for both paths.

### Runtime hardening (authoring experience)

- `validateGraph`/`validateFragment` gain a rule: for every `agent` and
  `human_gate` node, each `${identifier}` in `prompt` must be a key of that node's
  `input` map. An unmapped placeholder is a validation error naming the node and
  the placeholder. This matches `interpolate`, which resolves `${name}` only from
  `node.input[name]`.
- The `interpolate` runtime fallback (return the literal on a missing ref) is kept
  as defense in depth; validation catches the mistake earlier, at the tool call.

## Testing Decisions

- **What makes a good test here:** assert external behavior at the highest seam —
  the validator verdict and the tool's run outcome — never a node actor's private
  state. A graph is data, so the primary test is "does `validateGraph` accept the
  good shape and reject the bad shape with a locating message," and the integration
  test is "does the tool run the graph to a settled outcome."
- **Primary seam (preferred, highest):** `validateGraph` / `validateFragment` in
  `extensions/subagents/src/graph/validate.ts`. The unmapped-placeholder rule and
  all portfolio graphs are checked here. One seam covers authoring correctness.
- **Integration seam:** the `agent_graph` tool `execute` (registered in
  `extensions/subagents/src/index.ts`), exercised with a stub or real `NodeHost` to
  a settled `WorkflowTask` outcome.
- **Modules tested:** `validate.ts` (placeholder rule + portfolio graphs parse and
  validate), and the tool path end-to-end for at least one composite graph.
- **Prior art:** `extensions/subagents/test/graph-validate.test.ts` (validator
  cases), `graph-tool.test.ts` (tool registration + run to notification),
  `graph-run.test.ts` / `graph-subgraph.test.ts` / `graph-expand.test.ts` (runner,
  subgraph, expansion), `graph-scheduler.test.ts` (readiness/loops).
- **Real-run evidence:** at least one composite graph is run for real via
  `agent_graph` and observed to completion in `/agents → Workflows`, with the
  settled outcome captured. Real runs use small inputs so the graph mechanics — not
  agent depth — are what is exercised.
- **Baseline:** the extension suite has a documented 9 pre-existing failures
  unrelated to graph work (Herdr-pane WIP + macOS `/tmp` symlink artifacts). Green
  means "no new failures beyond that baseline."

## Out of Scope

- The P8 legacy-runtime removal itself (relocating shared monitor types, deleting
  `runtime.ts` / `worker-source.ts` / `meta.ts`, the `SubagentWorkflow` tool, and
  the two out-of-scope scripts). This spec establishes the parity that unblocks it;
  the removal is executed and recorded separately.
- Worktree-isolated workspace resources for Hou Tu (design §2.3). The portfolio
  uses a single `workspace:main` resource; per-worktree resources are future work.
- Richer `human_gate` forms beyond approve/reject (design §1.3 ceiling).
- Graph-engineering tooling — inspect/extract/promote automation (design §2.6).
- Expanding the portfolio beyond the initial six until repeated usage proves a
  stage has independent caller value (design §2.5).

## Further Notes

- The three shared subgraphs are reusable capabilities, not user-facing workflow
  boundaries: `shared/context-gather` deliberately stays a subgraph so Fu Xi and
  Kua Fu share one evidence format and the monitor still shows gathering as part of
  the current run.
- The promotion path (design §2.4) is preserved: an inline `GraphFragment` proven
  useful can be saved under `agent-graphs/shared/<name>.graph.json` with no
  rewrite.
- `houtu/execute-plan` and `kuafu/ulw` depend on an upstream agent emitting a
  well-formed `GraphFragment`. The runtime's contract is to validate and reject a
  malformed fragment cleanly; agent output quality is a separate concern from
  runtime correctness.
