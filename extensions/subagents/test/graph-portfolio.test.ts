import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSavedGraph } from "../src/graph/saved-graph.js";
import { validateGraph } from "../src/graph/validate.js";

/**
 * The shipped reusable agent-graph portfolio in the committed `agent-graphs/` directory
 * must always resolve and validate. These saved graphs are Pi's known-good starting
 * points, so a shape regression in one of them should fail here rather than at a live
 * tool call. `cwd` is the repo root, mirroring how the runtime resolves
 * `agent-graphs/<name>.graph.json` in production.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function portfolioNames(directory = join(REPO_ROOT, "agent-graphs"), prefix: string[] = []): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      names.push(...portfolioNames(join(directory, entry.name), [...prefix, entry.name]));
      continue;
    }
    const match = /^(.*)\.graph\.(json|yaml)$/.exec(entry.name);
    if (match?.[1]) names.push([...prefix, match[1]].join("/"));
  }
  return names;
}

const PORTFOLIO = portfolioNames().sort();

describe("agent-graph reusable portfolio", () => {
  it("discovers saved graphs", () => {
    expect(PORTFOLIO.length).toBeGreaterThan(0);
  });

  for (const name of PORTFOLIO) {
    it(`resolves and validates ${name}`, () => {
      const resolved = resolveSavedGraph(name, REPO_ROOT);
      expect(resolved.ok, resolved.ok ? "" : resolved.message).toBe(true);
      if (!resolved.ok) return;
      const verdict = validateGraph(resolved.graph);
      expect(verdict.ok, verdict.errors.join("\n")).toBe(true);
    });
  }
});
