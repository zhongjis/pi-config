import { stripVTControlCharacters } from "node:util";
import type { GraphNodePresentation, WorkflowAgentEntry } from "./progress.js";

/** All references are WorkflowAgentEntry indices scoped to one history run. */
export interface HistoryTopology extends Pick<GraphNodePresentation, "kind" | "name" | "role" | "iteration" | "itemIndex" | "iterations"> {
  parentIndex?: number;
  connections?: GraphNodePresentation["historyConnections"];
}
export const historyText = (value: string): string => stripVTControlCharacters(value).replace(/[\s\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+/gu, " ").trim().slice(0, 160);
export const historyInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const historyString = (value: unknown): value is string => typeof value === "string" && value.length <= 160;
export const historyIndices = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 32 && value.every(historyInteger);

/** Decode an allowlist, never copy untrusted objects into presentation. */
export function decodeTopology(value: unknown): HistoryTopology | undefined {
  if (!record(value) || !historyString(value.name)) return;
  if (value.kind !== "agent" && value.kind !== "fanout" && value.kind !== "bounded_feedback" && value.kind !== "graph" && value.kind !== "expand" && value.kind !== "human_gate") return;
  const topology: HistoryTopology = { kind: value.kind, name: historyText(value.name) };
  for (const key of ["parentIndex", "iteration", "itemIndex"] as const) {
    if (value[key] === undefined) continue;
    if (!historyInteger(value[key])) return;
    topology[key] = value[key];
  }
  if (value.role !== undefined) {
    if (value.role !== "work" && value.role !== "evaluator" && value.role !== "item") return;
    topology.role = value.role;
  }
  if (value.connections !== undefined) {
    if (!Array.isArray(value.connections) || value.connections.length > 32) return;
    const connections: NonNullable<HistoryTopology["connections"]>[number][] = [];
    for (const edge of value.connections) {
      if (!record(edge) || !historyInteger(edge.index) || (edge.direction !== "upstream" && edge.direction !== "downstream") || (edge.kind !== "conditional" && edge.kind !== "loop")) return;
      connections.push({ index: edge.index, direction: edge.direction, kind: edge.kind });
    }
    topology.connections = connections;
  }
  if (value.iterations !== undefined) {
    if (!Array.isArray(value.iterations) || value.iterations.length > 64) return;
    const iterations: NonNullable<HistoryTopology["iterations"]>[number][] = [];
    for (const row of value.iterations) {
      if (!record(row) || !historyInteger(row.iteration) || iterations.some(other => other.iteration === row.iteration) || (row.decision !== undefined && row.decision !== "continue" && row.decision !== "sufficient")) return;
      iterations.push({ iteration: row.iteration, ...(row.decision === undefined ? {} : { decision: row.decision }) });
    }
    topology.iterations = iterations;
  }
  return topology;
}

export function captureTopology(entry: WorkflowAgentEntry, retained: readonly WorkflowAgentEntry[]): HistoryTopology | undefined {
  const meta = entry.presentation;
  if (!meta) return;
  return decodeTopology({
    kind: meta.kind, name: historyText(meta.name), role: meta.role, iteration: meta.iteration, itemIndex: meta.itemIndex,
    parentIndex: retained.find(node => node.instanceId !== undefined && node.instanceId === meta.parentInstanceId)?.index,
    connections: meta.connections?.flatMap(edge => {
      const target = retained.find(node => node.nodeBinding === edge.binding);
      return target ? [{ index: target.index, direction: edge.direction, kind: edge.kind }] : [];
    }).slice(0, 32),
    iterations: meta.iterations?.slice(0, 64).map(row => ({ iteration: row.iteration, decision: row.decision })),
  });
}

export interface HistoryReferences {
  index: number;
  topology?: HistoryTopology;
  depIndices?: number[];
  dependentIndices?: number[];
}
export function validHistoryReferences(nodes: readonly HistoryReferences[]): boolean {
  const byIndex = new Map(nodes.map(node => [node.index, node]));
  for (const node of nodes) {
    const refs = [...node.depIndices ?? [], ...node.dependentIndices ?? [], ...node.topology?.connections?.map(edge => edge.index) ?? []];
    if (refs.some(index => !byIndex.has(index))) return false;
    const seen = new Set([node.index]);
    let parent = node.topology?.parentIndex;
    if (parent !== undefined) {
      const owner = byIndex.get(parent)?.topology;
      const child = node.topology;
      const representable = child?.itemIndex !== undefined
        ? child.kind === "agent" && owner?.kind === "fanout"
        : child?.iteration !== undefined && owner?.kind === "bounded_feedback" &&
          (child.role === "work" ? child.kind === "fanout" : child.role === "evaluator" && child.kind === "agent");
      if (!representable) return false;
    }
    while (parent !== undefined) {
      if (seen.has(parent) || !byIndex.has(parent)) return false;
      seen.add(parent);
      parent = byIndex.get(parent)?.topology?.parentIndex;
    }
  }
  return true;
}

/** Tail eviction must not leave a dangling parent, edge or flow reference. */
export function pruneHistoryReferences<T extends HistoryReferences>(nodes: readonly T[]): T[] {
  const indices = new Set(nodes.map(node => node.index));
  return nodes.map(node => ({
    ...node,
    ...(node.depIndices ? { depIndices: node.depIndices.filter(index => indices.has(index)) } : {}),
    ...(node.dependentIndices ? { dependentIndices: node.dependentIndices.filter(index => indices.has(index)) } : {}),
    ...(node.topology ? { topology: { ...node.topology,
      parentIndex: node.topology.parentIndex !== undefined && indices.has(node.topology.parentIndex) ? node.topology.parentIndex : undefined,
      connections: node.topology.connections?.filter(edge => indices.has(edge.index)),
    } } : {}),
  }));
}
