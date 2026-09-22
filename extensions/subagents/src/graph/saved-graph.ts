/**
 * saved-graph.ts — resolve `agent_graph({ graph: "<name>" })` to a `.graph.json`.
 *
 * A saved graph is a plain JSON file holding an {@link AgentGraph}. Names are
 * namespaced with `/` (e.g. `team/my-graph`), mapping to
 * `<root>/team/my-graph.graph.json`. Roots search, highest priority first:
 * project `.pi/agent-graphs`, the repo-committed `agent-graphs`, the shared
 * `.agents` workspace, then the user's agent dir (`~/.pi/agent/agent-graphs`,
 * where install.sh links a repo's committed graphs for global use).
 *
 * Nothing here validates the graph's shape; the caller runs {@link validateGraph}
 * on whatever JSON comes back, so an inline graph and a saved one fail the same
 * way. This only decides which file a name means and that it parses as JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** File suffix a saved graph carries. */
export const GRAPH_EXTENSION = ".graph.json";

/** One segment of a graph name: letters, digits, dot, hyphen, underscore. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Lookup roots for a saved graph, highest priority first. */
export function agentGraphRoots(cwd: string): string[] {
  return [
    join(cwd, ".pi", "agent-graphs"),
    join(cwd, "agent-graphs"),
    join(cwd, ".agents", "agent-graphs"),
    join(getAgentDir(), "agent-graphs"),
  ];
}

export type SavedGraph =
  | { ok: true; graph: unknown; path: string }
  | { ok: false; message: string };

/**
 * Resolve a namespaced graph name to its parsed JSON.
 *
 * Every path segment is whitelisted before it is joined, so a name that arrives
 * from a model cannot escape the roots with `..` or an absolute path.
 */
export function resolveSavedGraph(name: string, cwd: string): SavedGraph {
  const trimmed = name.trim();
  const segments = trimmed.split("/");
  if (segments.length === 0 || segments.some(segment => segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment))) {
    return {
      ok: false,
      message:
        `"${name}" is not a usable graph name. Use letters, digits, dots, hyphens, underscores, and "/" for ` +
        "namespaces only.",
    };
  }

  const relative = `${join(...segments)}${GRAPH_EXTENSION}`;
  const roots = agentGraphRoots(cwd);
  for (const root of roots) {
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (error) {
      return { ok: false, message: `Could not read graph "${path}": ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      return { ok: true, graph: JSON.parse(raw), path };
    } catch (error) {
      return { ok: false, message: `Graph "${path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: false, message: `No saved graph named "${trimmed}". Looked in: ${roots.join(", ")}.` };
}
