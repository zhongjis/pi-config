import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSavedGraph } from "../src/graph/saved-graph.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function seed(relative: string, content: string): string {
  root = mkdtempSync(join(tmpdir(), "agent-graphs-"));
  const path = join(root, ".pi", "agent-graphs", relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return root;
}

const validGraph = JSON.stringify({ nodes: { a: { type: "agent", agent: "x", prompt: "p" } }, edges: [] });

describe("resolveSavedGraph", () => {
  it("resolves a namespaced graph name to parsed JSON", () => {
    const cwd = seed("shared/review-loop.graph.json", validGraph);
    const result = resolveSavedGraph("shared/review-loop", cwd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph).toEqual(JSON.parse(validGraph));
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
});
