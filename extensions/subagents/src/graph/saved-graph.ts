/**
 * saved-graph.ts — resolve `agent_graph({ graph: "<name>" })` to a saved graph.
 *
 * A saved graph is a plain JSON or YAML file holding an {@link AgentGraph}. Names
 * are namespaced with `/` (e.g. `team/my-graph`), mapping to
 * `<root>/team/my-graph.graph.json` or `.graph.yaml`. Roots search, highest
 * priority first: project `.pi/agent-graphs`, the repo-committed `agent-graphs`,
 * the shared `.agents` workspace, then the user's agent dir
 * (`~/.pi/agent/agent-graphs`, where install.sh links a repo's committed graphs
 * for global use).
 *
 * Nothing here validates the graph's shape; the caller runs {@link validateGraph}
 * on the parsed JSON-compatible value, so an inline graph and a saved one fail the
 * same way. This only decides which file a name means and parses it safely.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseDocument } from "yaml";

/** File suffixes a saved graph may carry. */
export const GRAPH_EXTENSIONS = [".graph.json", ".graph.yaml"] as const;
export type SavedGraphFormat = "json" | "yaml";

const SAVED_GRAPH_FILES = [
  { extension: GRAPH_EXTENSIONS[0], format: "json" },
  { extension: GRAPH_EXTENSIONS[1], format: "yaml" },
] as const satisfies readonly { extension: string; format: SavedGraphFormat }[];

/** Limits alias expansion while retaining ordinary YAML aliases. */
const MAX_YAML_ALIAS_COUNT = 50;

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
  | { ok: true; graph: unknown; path: string; format: SavedGraphFormat }
  | { ok: false; message: string };

function isJsonCompatible(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;

  ancestors.add(value);
  const compatible = Array.isArray(value)
    ? value.every(item => isJsonCompatible(item, ancestors))
    : Object.values(value).every(item => isJsonCompatible(item, ancestors));
  ancestors.delete(value);
  return compatible;
}

function parseYamlGraph(raw: string, path: string): SavedGraph {
  try {
    const document = parseDocument(raw, {
      customTags: [],
      merge: false,
      resolveKnownTags: false,
      schema: "core",
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2",
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      const errors = [...document.errors, ...document.warnings].map(error => error.message).join(" ");
      return { ok: false, message: `Graph "${path}" is not valid YAML: ${errors}` };
    }
    const graph = document.toJS({ maxAliasCount: MAX_YAML_ALIAS_COUNT });
    if (!isJsonCompatible(graph)) {
      return { ok: false, message: `Graph "${path}" must contain only JSON-compatible values.` };
    }
    return { ok: true, graph, path, format: "yaml" };
  } catch (error) {
    return { ok: false, message: `Graph "${path}" is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Resolve a namespaced graph name to its parsed JSON-compatible value.
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

  const relative = join(...segments);
  const roots = agentGraphRoots(cwd);
  for (const root of roots) {
    const candidates = SAVED_GRAPH_FILES
      .map(file => ({ ...file, path: join(root, `${relative}${file.extension}`) }))
      .filter(candidate => existsSync(candidate.path));
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      return {
        ok: false,
        message: `Saved graph "${trimmed}" is ambiguous in "${root}": found both .graph.json and .graph.yaml.`,
      };
    }

    const candidate = candidates[0];
    let raw: string;
    try {
      raw = readFileSync(candidate.path, "utf-8");
    } catch (error) {
      return { ok: false, message: `Could not read graph "${candidate.path}": ${error instanceof Error ? error.message : String(error)}` };
    }
    if (candidate.format === "yaml") return parseYamlGraph(raw, candidate.path);
    try {
      return { ok: true, graph: JSON.parse(raw), path: candidate.path, format: "json" };
    } catch (error) {
      return { ok: false, message: `Graph "${candidate.path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: false, message: `No saved graph named "${trimmed}". Looked in: ${roots.join(", ")}.` };
}

/** List resolvable saved graph names using the same roots and ambiguity rules as resolution. */
export function listSavedGraphNames(cwd: string): string[] {
  const claimed = new Set<string>();
  const names = new Set<string>();
  for (const root of agentGraphRoots(cwd)) {
    for (const name of collectRootGraphNames(root)) {
      if (claimed.has(name)) continue;
      claimed.add(name);
      if (resolveSavedGraph(name, cwd).ok) names.add(name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function collectRootGraphNames(root: string): Set<string> {
  const names = new Set<string>();
  const visit = (directory: string, prefix: string[]): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || !SAFE_SEGMENT.test(entry.name)) continue;
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), [...prefix, entry.name]);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const file = SAVED_GRAPH_FILES.find(candidate => entry.name.endsWith(candidate.extension));
      if (!file) continue;
      const segment = entry.name.slice(0, -file.extension.length);
      if (segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment)) continue;
      names.add([...prefix, segment].join("/"));
    }
  };
  visit(root, []);
  return names;
}
