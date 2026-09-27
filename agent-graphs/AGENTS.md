## Purpose

The repo-committed reusable agent-graph portfolio: saved `AgentGraph`s the `agent_graph` tool runs.

## Ownership

- Owns `context-gather.graph.json` and `deep-research.graph.json` at the directory root.
- The `agent_graph` runtime and its contracts live in [../extensions/subagents](../extensions/subagents/AGENTS.md).
- The portfolio spec is [../docs/specs/agent-graph-reusable-workflows.md](../docs/specs/agent-graph-reusable-workflows.md).

## Local Contracts

- Saved graphs are JSON or YAML `AgentGraph`s resolved by filename (`context-gather`, `deep-research`); a `/` in a graph name maps to a subdirectory. Within one resolution root, matching `.graph.json` and `.graph.yaml` files are ambiguous.
- Every graph MUST pass `validateGraph`; a prompt `${placeholder}` MUST be wired in the node's `input`, except a bounded-feedback evaluator's runtime-reserved `${feedback}`.
- Nodes select work by `agent`; model and thinking come only from that agent's frontmatter chain. Saved graphs MUST NOT set node model, effort, or thinking.
- `install.sh` symlinks this directory to `~/.pi/agent/agent-graphs` for global resolution; the runtime also resolves `<cwd>/agent-graphs` and `<cwd>/.pi/agent-graphs`, highest priority first.
- `context-gather` accepts `{ request, requiredCoverage }`, plans 1–6 non-overlapping atomic-evidence tasks, and may run one evaluator-authored gap-closing iteration before synthesis. Graph-owned bounds allow at most 2 iterations, 6 tasks per iteration, and 9 total tasks. Its evaluator judges state and transition: continue only for one named material gap with distinct source/access, expected information, and no repeated or broader work; otherwise preserve partial gaps. Synthesis MUST declare partial when material required coverage remains missing.
- `context-gather` opts into `semanticPolicy: "context-gather-v1"`: requested coverage IDs are unique; plan tasks cover all requested IDs, and continuation tasks stay within them. Synthesis retains exact completed research claims (duplicate raw claim IDs are invalid), covers each requested ID exactly once, and links only matching retained claims. Supported coverage needs a direct claim; succeeded needs all coverage supported. These deterministic checks do not verify source truth.
- `deep-research` accepts a nonblank `{ question, context? }`, plans 1–6 disjoint verifiable tasks, dispatches local to Chengfeng and external GitHub/public web to Wenchang, and uses read-only Wenchang for planning, independent-source evaluation, and synthesis. Its bounded feedback permits at most 3 rounds, 6 tasks/round and 18 total, follows only named gaps, and retains all-settled failures.
- Deep-research output includes cited Markdown, accepted findings, verified coverage, rejected claims, gaps, failures, and a declared succeeded/partial/failed outcome. Selected disputed, consequential or weak claims warrant independent-source checks; schemas validate shape, not factual truth or source independence. Agent choice uses read-only selectors, not a filesystem/permission sandbox; runtime owns oversized completion artifacts.
- Deep-research evaluation opens primary sources directly; material actionable gaps receive distinct accessible source checks (including alternate fetch methods), while sufficient with gaps ends partial only when no useful accessible check remains. Runtime, not evaluator, enforces bounds.

## Work Guidance

- Depend only on validated structured node output (`outputSchema` + ValueRef), never on an agent's prose.
- Promote a proven inline graph here; keep node ids and dependencies explicit.

## Verification

- `pnpm --dir extensions/subagents exec vitest run test/graph-portfolio.test.ts test/graph-deep-research.test.ts` validates saved graphs and exercises context-gather planning, gap closure, partial Outcomes, plus deep-research wiring and failures.

## Child DOX Index

- None.
