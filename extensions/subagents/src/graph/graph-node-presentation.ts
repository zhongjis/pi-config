import type { GraphRuntimeState, NodeInstance } from "./graph-instance-id.js";
import type { GraphEdge, GraphNode } from "./ir.js";
import type { GraphNodePresentation } from "./progress.js";

/** Transient inspector facts derived from committed ownership, never persisted. */
export function nodePresentation(node: GraphNode, instance: NodeInstance, runtime: GraphRuntimeState): GraphNodePresentation {
  const parent = runtime.manifest.find(row => row.instanceId === instance.parentInstanceId);
  const feedback = parent ? runtime.feedback?.[parent.binding] : undefined;
  const round = feedback?.active?.iteration === instance.iteration ? feedback?.active
    : feedback?.iterations.find(row => row.iteration === instance.iteration);
  const owned = runtime.feedback?.[instance.binding];
  return {
    kind: node.type, name: node.name || (node.type === "agent" ? node.agent : node.type.replaceAll("_", " ")),
    ...(instance.parentInstanceId ? { parentInstanceId: instance.parentInstanceId } : {}),
    ...(instance.iteration !== undefined ? { iteration: instance.iteration } : {}),
    ...(instance.itemIndex !== undefined ? { itemIndex: instance.itemIndex, role: "item" as const } :
      round?.work === instance.binding ? { role: "work" as const } : round?.evaluator === instance.binding ? { role: "evaluator" as const } : {}),
    ...(owned ? { iterations: [...owned.iterations.map(row => ({ iteration: row.iteration, ...(row.decision ? { decision: row.decision.decision } : {}) })),
      ...(owned.active ? [{ iteration: owned.active.iteration }] : [])] } : {}),
  };
}

export function graphConnections(edges: readonly GraphEdge[], id: string): NonNullable<GraphNodePresentation["connections"]> {
  return edges.flatMap(edge => (edge.from === id || edge.to === id) && (edge.loop || edge.when)
    ? [{ binding: edge.from === id ? edge.to : edge.from, direction: edge.from === id ? "downstream" as const : "upstream" as const, kind: edge.loop ? "loop" as const : "conditional" as const }] : []);
}
