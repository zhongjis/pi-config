## Purpose

The repo-committed reusable agent-graph portfolio: saved `AgentGraph`s the `agent_graph` tool runs.

## Ownership

- Owns the saved `.graph.json` graphs under `shared/`, `fuxi/`, `houtu/`, `kuafu/`.
- The `agent_graph` runtime and its contracts live in [../extensions/subagents](../extensions/subagents/AGENTS.md).
- The portfolio spec is [../docs/specs/agent-graph-reusable-workflows.md](../docs/specs/agent-graph-reusable-workflows.md).

## Local Contracts

- Each file is a plain-JSON `AgentGraph`, namespaced by directory (e.g. `shared/review-loop`).
- Every graph MUST pass `validateGraph`; a prompt `${placeholder}` MUST be wired in the node's `input`.
- `install.sh` symlinks this directory to `~/.pi/agent/agent-graphs` for global resolution; the runtime also resolves `<cwd>/agent-graphs` and `<cwd>/.pi/agent-graphs`, highest priority first.

## Work Guidance

- Depend only on validated structured node output (`outputSchema` + ValueRef), never on an agent's prose.
- Promote a proven inline graph here; keep node ids and dependencies explicit.

## Verification

- `pnpm --dir extensions/subagents exec vitest run test/graph-portfolio.test.ts` resolves and validates every graph here.

## Child DOX Index

- None.
