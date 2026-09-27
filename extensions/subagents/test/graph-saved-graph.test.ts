import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSavedGraphNames, resolveSavedGraph } from "../src/graph/saved-graph.js";
import { validateGraph } from "../src/graph/validate.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function write(relative: string, content: string): void {
  if (!root) throw new Error("Test root has not been created");
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function seed(relative: string, content: string): string {
  root = mkdtempSync(join(tmpdir(), "agent-graphs-"));
  write(join(".pi", "agent-graphs", relative), content);
  return root;
}

const graph = { nodes: { a: { type: "agent", agent: "x", prompt: "p" } }, edges: [] };
const validGraph = JSON.stringify(graph);
const validYaml = "nodes:\n  a:\n    type: agent\n    agent: x\n    prompt: p\nedges: []\n";

describe("resolveSavedGraph", () => {
  it("resolves a namespaced graph name to parsed JSON", () => {
    const cwd = seed("shared/review-loop.graph.json", validGraph);
    const result = resolveSavedGraph("shared/review-loop", cwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.format).toBe("json");
      expect(result.graph).toEqual(graph);
      expect(validateGraph(result.graph).ok).toBe(true);
    }
  });

  it("resolves YAML through the same validation path", () => {
    const cwd = seed("shared/review-loop.graph.yaml", validYaml);
    const result = resolveSavedGraph("shared/review-loop", cwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.format).toBe("yaml");
      expect(result.graph).toEqual(graph);
      expect(validateGraph(result.graph).ok).toBe(true);
    }
  });

  it("retains root precedence across saved graph formats", () => {
    const cwd = seed("priority.graph.yaml", `${validYaml}description: project\n`);
    write("agent-graphs/priority.graph.json", JSON.stringify({ ...graph, description: "repository" }));
    const result = resolveSavedGraph("priority", cwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.format).toBe("yaml");
      expect(result.path).toContain(join(".pi", "agent-graphs", "priority.graph.yaml"));
      expect(result.graph).toMatchObject({ description: "project" });
    }
  });

  it("lists only runtime-resolvable names with root precedence", () => {
    const cwd = seed("catalog/review.graph.yaml", validYaml);
    write("agent-graphs/catalog/review.graph.json", validGraph);
    write("agent-graphs/catalog/other.graph.json", validGraph);
    write(".pi/agent-graphs/catalog/ambiguous.graph.json", validGraph);
    write(".pi/agent-graphs/catalog/ambiguous.graph.yaml", validYaml);
    const names = listSavedGraphNames(cwd);
    expect(names).toEqual(expect.arrayContaining(["catalog/other", "catalog/review"]));
    expect(names).not.toContain("catalog/ambiguous");
  });

  it("resolves and catalogs symlinked graph files without traversing symlinked directories", () => {
    const cwd = seed("linked.graph.json", validGraph);
    const graphRoot = join(cwd, ".pi", "agent-graphs");
    const target = join(cwd, "outside", "linked.graph.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, validGraph, "utf-8");
    rmSync(join(graphRoot, "linked.graph.json"));
    symlinkSync(target, join(graphRoot, "linked.graph.json"));
    mkdirSync(join(cwd, "outside"), { recursive: true });
    writeFileSync(join(cwd, "outside", "nested.graph.json"), validGraph, "utf-8");
    symlinkSync(join(cwd, "outside"), join(graphRoot, "directory-link"), "dir");

    const resolved = resolveSavedGraph("linked", cwd);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.graph).toEqual(graph);
    expect(listSavedGraphNames(cwd)).toContain("linked");
    expect(listSavedGraphNames(cwd)).not.toContain("directory-link/nested");
  });

  it("rejects same-root JSON and YAML ambiguity without falling through", () => {
    const cwd = seed("ambiguous.graph.json", validGraph);
    write(join(".pi", "agent-graphs", "ambiguous.graph.yaml"), validYaml);
    write("agent-graphs/ambiguous.graph.json", validGraph);
    const result = resolveSavedGraph("ambiguous", cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("ambiguous");
      expect(result.message).toContain(join(".pi", "agent-graphs"));
    }
  });

  it("reports a missing graph", () => {
    const cwd = seed("shared/present.graph.json", validGraph);
    const result = resolveSavedGraph("shared/absent", cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("No saved graph");
  });

  it("rejects a traversal name", () => {
    const cwd = seed("ok.graph.json", validGraph);
    const result = resolveSavedGraph("../../etc/passwd", cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not a usable graph name");
  });

  it("reports invalid JSON", () => {
    const cwd = seed("broken.graph.json", "{ not json");
    const result = resolveSavedGraph("broken", cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not valid JSON");
  });

  it("rejects duplicate YAML keys", () => {
    const cwd = seed("duplicate.graph.yaml", "nodes: {}\nnodes: {}\nedges: []\n");
    const result = resolveSavedGraph("duplicate", cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Map keys must be unique");
  });

  it("rejects unsafe and excessive YAML aliases", () => {
    const recursive = seed("recursive.graph.yaml", "nodes: &node { self: *node }\nedges: []\n");
    const recursiveResult = resolveSavedGraph("recursive", recursive);
    expect(recursiveResult.ok).toBe(false);
    if (!recursiveResult.ok) expect(recursiveResult.message).toContain("JSON-compatible");

    write(".pi/agent-graphs/aliases.graph.yaml", `nodes: &node { a: one, b: two }\nedges:\n${"  - *node\n".repeat(51)}`);
    const aliasesResult = resolveSavedGraph("aliases", recursive);
    expect(aliasesResult.ok).toBe(false);
    if (!aliasesResult.ok) expect(aliasesResult.message).toContain("alias");
  });

  it("rejects custom tags and non-JSON-compatible YAML values", () => {
    const cwd = seed("tag.graph.yaml", "nodes: {}\nedges: []\ncreated: !!timestamp 2024-01-01\n");
    const tagResult = resolveSavedGraph("tag", cwd);
    expect(tagResult.ok).toBe(false);
    if (!tagResult.ok) expect(tagResult.message).toContain("tag");

    write(".pi/agent-graphs/infinite.graph.yaml", "nodes: {}\nedges: []\nvalue: .inf\n");
    const infiniteResult = resolveSavedGraph("infinite", cwd);
    expect(infiniteResult.ok).toBe(false);
    if (!infiniteResult.ok) expect(infiniteResult.message).toContain("JSON-compatible");
  });
});
