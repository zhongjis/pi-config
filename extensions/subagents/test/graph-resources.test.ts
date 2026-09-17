import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";

/** A host that records the peak number of concurrently active spawns. */
function peakHost(): { host: NodeHost; peak: () => number } {
  let active = 0;
  let peak = 0;
  const host: NodeHost = {
    spawnAgent: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active--;
      return { ok: true, output: "ok" };
    },
  };
  return { host, peak: () => peak };
}

/** Two independent nodes that both need the same named resource. */
const graph: AgentGraph = {
  nodes: {
    a: { type: "agent", agent: "x", prompt: "a", resources: ["workspace:main"] },
    b: { type: "agent", agent: "x", prompt: "b", resources: ["workspace:main"] },
  },
  edges: [],
};

describe("runGraph — named resource capacities", () => {
  it("serialises nodes that share a resource at capacity 1", async () => {
    const { host, peak } = peakHost();
    const result = await runGraph(graph, {}, { host, resources: { "workspace:main": { capacity: 1 } } });
    expect(result.status).toBe("completed");
    expect(peak()).toBe(1);
  });

  it("lets them overlap at capacity 2", async () => {
    const { host, peak } = peakHost();
    const result = await runGraph(graph, {}, { host, resources: { "workspace:main": { capacity: 2 } } });
    expect(result.status).toBe("completed");
    expect(peak()).toBe(2);
  });

  it("treats an unconfigured resource as unlimited", async () => {
    const { host, peak } = peakHost();
    const result = await runGraph(graph, {}, { host });
    expect(result.status).toBe("completed");
    expect(peak()).toBe(2);
  });
});
