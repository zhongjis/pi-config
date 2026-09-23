## Purpose

The repo-committed reusable agent-graph portfolio: saved `AgentGraph`s the `agent_graph` tool runs.

## Ownership

- Owns `context-gather.graph.json` and `deep-research.graph.json` at the directory root.
- The `agent_graph` runtime and its contracts live in [../extensions/subagents](../extensions/subagents/AGENTS.md).
- The portfolio spec is [../docs/specs/agent-graph-reusable-workflows.md](../docs/specs/agent-graph-reusable-workflows.md).

## Local Contracts

- Saved graphs are plain-JSON `AgentGraph`s resolved by filename (`context-gather`, `deep-research`); a `/` in a graph name maps to a subdirectory.
- Every graph MUST pass `validateGraph`; a prompt `${placeholder}` MUST be wired in the node's `input`, except a bounded-feedback evaluator's runtime-reserved `${feedback}`.
- `install.sh` symlinks this directory to `~/.pi/agent/agent-graphs` for global resolution; the runtime also resolves `<cwd>/agent-graphs` and `<cwd>/.pi/agent-graphs`, highest priority first.
- `context-gather` accepts caller-planned `{ request, tasks }` through one bounded-feedback region, which may run one evaluator-authored gap-closing iteration before synthesis. Both bounded iterations collect partial failures as evidence; callers MUST check applicable Skills before creating tasks and MUST NOT add `practice` research by default.
- `deep-research` accepts a nonblank `{ question, context? }`, plans 1–6 disjoint verifiable tasks, dispatches local to Chengfeng and external GitHub/public web to Wenchang, and uses read-only Wenchang for planning, independent-source evaluation, and synthesis. Its bounded feedback permits at most 3 rounds, 6 tasks/round and 18 total, follows only named gaps, and retains all-settled failures.
- Deep-research output includes cited Markdown, accepted findings, verified coverage, rejected claims, gaps, failures, and a declared succeeded/partial/failed outcome. Selected disputed, consequential or weak claims warrant independent-source checks; schemas validate shape, not factual truth or source independence. Agent choice uses read-only selectors, not a filesystem/permission sandbox; runtime owns oversized completion artifacts.
- Deep-research evaluation opens primary sources directly; material actionable gaps receive distinct accessible source checks (including alternate fetch methods), while sufficient with gaps ends partial only when no useful accessible check remains. Runtime, not evaluator, enforces bounds.

## Work Guidance

- Depend only on validated structured node output (`outputSchema` + ValueRef), never on an agent's prose.
- Promote a proven inline graph here; keep node ids and dependencies explicit.

## Verification

- `pnpm --dir extensions/subagents exec vitest run test/graph-portfolio.test.ts test/graph-deep-research.test.ts` validates saved graphs and exercises deep-research wiring, sufficient coverage, and partial failures.

## Child DOX Index

- None.
