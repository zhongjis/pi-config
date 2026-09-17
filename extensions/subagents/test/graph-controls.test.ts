import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";

const agent = () => ({ type: "agent" as const, agent: "x", prompt: "p" });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

/** A host whose every spawn parks until the test resolves it by node id. */
function gatedHost() {
  const gates = new Map<string, (result: NodeSpawnResult) => void>();
  const started: string[] = [];
  const host: NodeHost = {
    spawnAgent: request =>
      new Promise<NodeSpawnResult>(resolve => {
        started.push(request.nodeId);
        gates.set(request.nodeId, resolve);
      }),
  };
  return {
    host,
    started,
    finish: (id: string, result: NodeSpawnResult) => gates.get(id)?.(result),
  };
}

// a -> b
const chain: AgentGraph = { nodes: { a: agent(), b: agent() }, edges: [{ from: "a", to: "b" }] };

describe("runGraph live controls", () => {
  it("pause stops new admission until resume", async () => {
    const g = gatedHost();
    let control!: GraphControl;
    const run = runGraph(chain, {}, { host: g.host, onControl: c => (control = c) });
    await tick();
    expect(g.started).toEqual(["a"]);

    control.pause();
    g.finish("a", { ok: true, output: "x" });
    await tick();
    expect(g.started).toEqual(["a"]); // b withheld while paused

    control.resume();
    await tick();
    expect(g.started).toEqual(["a", "b"]);
    g.finish("b", { ok: true, output: "y" });
    expect((await run).status).toBe("completed");
  });

  it("skips a pending node and its dependents", async () => {
    const g = gatedHost();
    let control!: GraphControl;
    const run = runGraph(chain, {}, { host: g.host, onControl: c => (control = c) });
    await tick();
    expect(control.skip(1)).toBe(true); // b is pending
    g.finish("a", { ok: true, output: "x" });
    const result = await run;
    expect(result.nodes.b.status).toBe("skipped");
  });

  it("skips a running node", async () => {
    const g = gatedHost();
    let control!: GraphControl;
    const run = runGraph(chain, {}, { host: g.host, onControl: c => (control = c) });
    await tick();
    expect(control.skip(0)).toBe(true); // a is running
    const result = await run;
    expect(result.nodes.a.status).toBe("skipped");
    expect(result.nodes.b.status).toBe("skipped");
  });

  it("retries a running node, re-running it", async () => {
    const g = gatedHost();
    let control!: GraphControl;
    const run = runGraph(chain, {}, { host: g.host, onControl: c => (control = c) });
    await tick();
    expect(control.retry(0)).toBe(true); // stop + re-run a
    await tick();
    expect(g.started.filter(id => id === "a").length).toBe(2);
    g.finish("a", { ok: true, output: "x" });
    await tick();
    g.finish("b", { ok: true, output: "y" });
    const result = await run;
    expect(result.status).toBe("completed");
    expect(result.nodes.a.attempt).toBe(2);
  });
});
