import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSavedGraph } from "../src/graph/saved-graph.js";
import { validateGraph } from "../src/graph/validate.js";

/**
 * The shipped reusable-workflow portfolio (docs/specs/agent-graph-reusable-workflows.md)
 * must always resolve and validate. These saved graphs are Pi's known-good
 * starting points, so a shape regression in one of them should fail here rather
 * than at a live tool call. `cwd` is the repo root, mirroring how the runtime
 * resolves `agent-graphs/<name>.graph.json` in production.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const PORTFOLIO = [
  "shared/context-gather",
  "shared/review-loop",
  "shared/work-verify",
  "fuxi/ulw-plan",
  "houtu/execute-plan",
  "kuafu/ulw",
] as const;

describe("agent-graph reusable-workflow portfolio", () => {
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
