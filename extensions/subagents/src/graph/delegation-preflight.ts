/**
 * delegation-preflight.ts — static delegation check for a whole agent graph.
 *
 * Before a graph runs, every agent it will spawn — directly, or through a saved
 * subgraph — must be within the caller's delegation allowlist. Otherwise the
 * denial only surfaces mid-run at spawn time, where it can escape as an uncaught
 * error and crash the process. This walks the graph (recursing into `graph` nodes
 * via an injected loader, guarding cycles) and asks a single `denyReason`
 * predicate about each distinct agent type, aggregating every denial into one
 * message that keeps the `delegation_policy_denied:` token so downstream
 * classification still works.
 *
 * Pure and dependency-light: it takes the graph, the predicate, and the loader —
 * no session, manager, or filesystem access.
 */

import { DELEGATION_POLICY_DENIED } from "../delegation-policy.js";
import type { AgentGraph } from "./ir.js";

export function checkGraphDelegation(
  graph: AgentGraph,
  denyReason: (agentType: string) => string | undefined,
  loadGraph?: (name: string) => AgentGraph | undefined,
): { ok: true } | { ok: false; error: string } {
  // Distinct agent type -> the node ids that reference it, across the whole tree.
  const usage = new Map<string, string[]>();
  // Guard subgraph recursion against cycles by remembering loaded graph names.
  const visited = new Set<string>();

  const walk = (current: AgentGraph): void => {
    for (const [id, node] of Object.entries(current.nodes)) {
      if (node.type === "agent" || node.type === "fanout" || node.type === "bounded_feedback") {
        const selectors = node.type === "agent" ? [node.agent] : node.type === "fanout"
          ? new Set(Object.values(node.dispatch.cases)) : new Set([node.evaluator.agent, ...Object.values(node.work.dispatch.cases)]);
        for (const selector of selectors) {
          const ids = usage.get(selector);
          if (ids === undefined) usage.set(selector, [id]);
          else ids.push(id);
        }
        continue;
      }
      if (node.type === "graph") {
        // No loader, or an unresolvable name: skip — the runtime handles it.
        if (loadGraph === undefined || visited.has(node.graph)) continue;
        visited.add(node.graph);
        const sub = loadGraph(node.graph);
        if (sub !== undefined) walk(sub);
      }
      // `expand` and `human_gate` spawn no statically-known agent: ignore.
    }
  };
  walk(graph);

  // One denyReason call per distinct agent type (map keys are already distinct).
  const denials: { agent: string; nodes: string[]; reason: string }[] = [];
  for (const [agent, nodes] of usage) {
    const reason = denyReason(agent);
    if (reason !== undefined) denials.push({ agent, nodes, reason });
  }

  if (denials.length === 0) return { ok: true };

  const bullets = denials.map(denial => `  • ${denial.agent} — used by node(s): ${denial.nodes.join(", ")}`).join("\n");
  const reasons = denials.map(denial => denial.reason).join("\n");
  const error =
    `${DELEGATION_POLICY_DENIED}: This graph cannot run — the active mode cannot delegate to some node agents:\n` +
    `${bullets}\n${reasons}`;
  return { ok: false, error };
}
