import type { NestedCheckpoint, NodeInstance } from "./graph-instance-id.js";
import type { AgentGraph, GraphNode } from "./ir.js";
import type { NodeRun, SchedulerState } from "./scheduler.js";

interface RestoredRow {
  readonly id: string;
  readonly key: string;
  readonly node: GraphNode;
  readonly run: NodeRun;
  readonly dependencies: string[];
  readonly ordinal: number;
  readonly instance?: NodeInstance;
}
export function nestedScope(binding: string, invocation: number): string { return invocation > 1 ? `${binding}#${invocation}` : binding; }

/** Includes every descendant and prior invocation using the same durable keys as reporting. */
export function nestedMaterializations(graph: AgentGraph, state: SchedulerState): RestoredRow[] {
  const rows: RestoredRow[] = (state.runtime?.manifest ?? []).map(instance => ({
    id: instance.binding, key: `${state.runtime?.runId}/${instance.instanceId}`,
    node: graph.nodes[instance.binding], run: state.nodes[instance.binding], ordinal: instance.ordinal,
    dependencies: graph.edges.filter(edge => edge.to === instance.binding).map(edge => edge.from),
    ...(graph.version === 2 ? { instance } : {}),
  }));
  for (const [binding, child] of Object.entries(state.runtime?.nested ?? {})) rows.push(...restoredNestedRows(child, binding));
  return rows.sort((left, right) => left.ordinal - right.ordinal);
}

/** Completed nested runs do not re-enter the dispatcher just to reconstruct monitor rows. */
export function restoredNestedRows(saved: NestedCheckpoint, binding: string): readonly RestoredRow[] {
  return [...saved.previous ?? [], saved].flatMap(checkpoint => {
    const prefix = nestedScope(binding, Number(checkpoint.state.runtime?.runId.split("/").at(-1)));
    return nestedMaterializations(checkpoint.graph, checkpoint.state).map(row => {
      const ordinal = checkpoint.ordinals[row.key];
      if (!Number.isSafeInteger(ordinal)) throw new TypeError("Missing nested materialization ordinal");
      return { ...row, ordinal, id: `${prefix}/${row.id}`, dependencies: row.dependencies.map(key => `${prefix}/${key}`), ...(row.instance ? { instance: { ...row.instance, ordinal } } : {}) };
    });
  }).sort((left, right) => left.ordinal - right.ordinal);
}
