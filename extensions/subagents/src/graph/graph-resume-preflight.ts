import { checkGraphDelegation } from "./delegation-preflight.js";
import type { GraphRunSnapshot } from "./graph-persist.js";
import { validateGraphRestore } from "./graph-restore-validation.js";
import type { AgentGraph } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";
import { validateGraph } from "./validate.js";

/** Authorization is current-session policy, never something a checkpoint can grant. */
export function authorizeGraphResume(snapshot: GraphRunSnapshot, policy: { deny(agent: string): string | undefined; load(name: string): AgentGraph | undefined }): void {
  const visited = new Set<AgentGraph>();
  const loaded = new Map<string, AgentGraph>();
  const walk = (graph: AgentGraph, state?: SchedulerState, input?: unknown): void => {
    if (visited.has(graph)) return;
    if (state?.runtime) validateGraphRestore(state, graph, input);
    const verdict = state?.runtime ? { ok: true, errors: [] } : validateGraph(graph);
    if (!verdict.ok) throw new TypeError(`Invalid restored graph: ${verdict.errors.join("; ")}`);
    visited.add(graph);
    for (const [key, node] of Object.entries(graph.nodes)) {
      if (node.type !== "graph") continue;
      const saved = Object.hasOwn(state?.runtime?.nested ?? {}, key) ? state?.runtime?.nested?.[key] : undefined;
      if (saved) for (const checkpoint of [...saved.previous ?? [], saved]) walk(checkpoint.graph, checkpoint.state, checkpoint.input);
      const resumes = saved && ["running", "completed"].includes(state?.nodes[key]?.status ?? "");
      const child = (resumes ? saved.graph : undefined) ?? loaded.get(node.graph) ?? policy.load(node.graph);
      if (!child) throw new TypeError(`Unresolvable restored subgraph: ${node.graph}`);
      if (!resumes) loaded.set(node.graph, child);
      walk(child, resumes ? saved.state : undefined, resumes ? saved.input : undefined);
    }
    const authorization = checkGraphDelegation(graph, policy.deny);
    if (!authorization.ok) throw new TypeError(authorization.error);
  };
  walk(snapshot.graph, snapshot.state, snapshot.input);
}
