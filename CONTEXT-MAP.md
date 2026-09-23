# Context Map

## Contexts

- [Panda Harness](./CONTEXT.md): harness-wide vocabulary — the Pi runtime, agents, extensions, packages, and documentation buckets.
- [Subagents Extension](./extensions/subagents/CONTEXT.md): agent-graph orchestration vocabulary — agent graphs, their runs, and node types.

## Relationships

- **Panda Harness → Subagents Extension**: the extension builds on the harness terms *Subagent* and *Agent* and refines them for typed multi-agent orchestration; it owns the agent-graph vocabulary the root context does not define.
