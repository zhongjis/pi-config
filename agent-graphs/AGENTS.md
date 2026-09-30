## Purpose

The repo-committed reusable agent-graph portfolio: saved `AgentGraph`s the `agent_graph` tool runs.

## Ownership

- Owns `context-gather.graph.json` and `deep-research.graph.json` at the directory root, and the `deep-research/plan.graph.json` subgraph.
- The `agent_graph` runtime and its contracts live in [../extensions/subagents](../extensions/subagents/AGENTS.md).

## Local Contracts

- Saved graphs are JSON or YAML `AgentGraph`s resolved by filename (`context-gather`, `deep-research`); a `/` in a graph name maps to a subdirectory. Within one resolution root, matching `.graph.json` and `.graph.yaml` files are ambiguous.
- Every graph MUST pass `validateGraph`; a prompt `${placeholder}` MUST be wired in the node's `input`, except a bounded-feedback evaluator's runtime-reserved `${feedback}`.
- Nodes select work by `agent`; model and thinking come only from that agent's frontmatter chain. Saved graphs MUST NOT set node model, effort, or thinking.
- `install.sh` symlinks this directory to `~/.pi/agent/agent-graphs` for global resolution. Resolution roots, highest priority first: `<cwd>/.pi/agent-graphs`, `<cwd>/agent-graphs`, `<cwd>/.agents/agent-graphs`, then `~/.pi/agent/agent-graphs`.
- Saved-graph outcome schemas MUST match the runtime envelope exactly: `succeeded` omits `reason`; `partial`/`failed` require a nonblank `reason`. Any other envelope is silently ignored and the run shows `Completed`.
- `context-gather` accepts `{ request, requiredCoverage }`, plans 1–6 non-overlapping atomic-evidence tasks, and may run one evaluator-authored gap-closing iteration before synthesis. Graph-owned bounds allow at most 2 iterations, 6 tasks per iteration, and 9 total tasks. Its evaluator judges state and transition: continue only for one named material gap with distinct source/access, expected information, and no repeated or broader work; otherwise preserve partial gaps. Synthesis MUST declare partial when material required coverage remains missing.
- `context-gather` hands identity to workers through items: plan tasks use `taskId` `t1`–`t6` and evaluator gap tasks `g1`–`g6` (collision-free only while `maxIterations` ≤ 2); worker `claimId`s follow `<taskId>-c<n>`. Schema patterns enforce the format; `context-gather-v1` enforces the rest: each claim's `claimId` starts with `<item.taskId>-` and its `criterionIds` are a subset of the item's, plan `taskId`s are unique, and gap `taskId`s are unique and disjoint from plan and earlier/current iteration IDs. Workers do not echo `source`; the runtime-carried item identifies it.
- `context-gather` opts into `semanticPolicy: "context-gather-v1"`: requested coverage IDs are unique; plan tasks cover all requested IDs, and continuation tasks stay within them. Synthesis retains exact completed research claims (duplicate raw claim IDs are invalid), covers each requested ID exactly once, and links only matching retained claims. Supported coverage needs a direct claim; succeeded needs all coverage supported. These deterministic checks do not verify source truth.
- `deep-research` accepts a nonblank `{ question, context? }` and runs autonomously, with no human gate. Its `planning` node runs the `deep-research/plan` subgraph: `seedQueries` (Wenchang) writes 1–4 short, broad seed queries; `seedSearch` fans them out; `plan` (Wenchang) uses that seed evidence to write 1–6 material question parts (`p1`–`p6`) and 1–6 disjoint tasks that each list the `partIds` they serve; `scope` (`agent_gate`, Panguan) approves or rejects the plan. A rejection re-plans once; a second rejection still proceeds, and the writer states that the plan failed the scope check. An undecided gate fails the run before research.
- Deep-research research dispatches local to Chengfeng and external GitHub/public web to Wenchang, and uses tool-free Panguan as the round evaluator. Its bounded feedback allows at most 3 rounds, 30 tasks, USD 2 of reported child cost (`spendLimit`), and 15 minutes (`deadline`); it has no separate per-round cap (runtime concurrency still bounds parallel workers), follows only named gaps, and retains all-settled failures. `spendLimit` needs every child to report cost; a child without cost ends research after that round.
- Every mode that runs `deep-research` MUST allow `panguan` and `simaqian` delegation.
- Deep-research planning gives origin, first-use, history or date parts a discovery task and a backward-chaining task. Workers record the publication date a source shows, or `undated`. Synthesis runs on tool-free Sima Qian and states no access dates.
- `deep-research` opts into `semanticPolicy: "deep-research-v1"`: code builds an evidence ledger with claim ids `r<round>-<item>-<claim>` (round 0 = seed, duplicates merged), and both the evaluator and the writer read that ledger instead of raw rounds; workers in round 2 and later receive the references already opened. The evaluator cannot return `sufficient` while a plan part has no ledger claim and no `<partId>-` gap. The writer cites ledger ids (`[r1-2-1]`) in Markdown and in `claimIds`; code rejects unknown ids, URLs outside the ledger, coverage that does not list each plan part exactly once, and `supported` coverage without a claim id. These checks do not verify source truth.
- Deep-research output includes the plan `parts`, cited Markdown, accepted findings (`claimIds`, `verification`: `independently-checked`, `single-source`, or `disputed`), per-part `verifiedCoverage` (`supported`/`partial`/`missing` with `claimIds` and reasons), rejected claims, gaps, failures, and a declared outcome. The synthesize schema forces the outcome from coverage: succeeded needs every part supported, at least one finding and none disputed; failed needs every part missing and no findings; partial needs at least one finding and a partial or missing part. Selected disputed, consequential or weak claims warrant independent-source checks; schemas and the policy validate shape and traceability, not factual truth or source independence. Agent choice uses read-only selectors, not a filesystem/permission sandbox; runtime owns oversized completion artifacts.
- Deep-research evaluation judges only supplied ledger evidence and opens no sources: every plan part is material, worker gaps carry forward until a claim closes them, and independent checks of disputed, consequential or weak claims run as worker tasks. Material gaps receive tasks with distinct untried access routes (alternate sources, public APIs or mirrors, archives, backward chaining); sufficient with gaps ends partial only when no untried accessible route remains. Runtime, not evaluator, enforces bounds.

## Work Guidance

- Depend only on validated structured node output (`outputSchema` + ValueRef), never on an agent's prose.
- Promote a proven inline graph here; keep node ids and dependencies explicit.

## Verification

- `pnpm --dir extensions/subagents exec vitest run test/graph-portfolio.test.ts test/graph-deep-research-policy.test.ts` validates saved graphs and exercises context-gather policy; graph-deep-research-policy covers deep-research policy.

## Child DOX Index

- None.
