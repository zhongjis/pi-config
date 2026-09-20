import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeSpawnResult } from "../src/graph/node-host.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("not initialized"); };
  let reject: (error: Error) => void = () => { throw new Error("not initialized"); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const agent = { type: "agent", agent: "worker", prompt: "fixture", resources: ["exclusive"] } as const;
const graph: AgentGraph = { nodes: { a: { ...agent, resources: ["exclusive"] }, b: { ...agent, resources: ["exclusive"] } }, edges: [] };

const capacityCases = (["skip", "retry"] as const).flatMap(action =>
  [false, true].flatMap(reject => ["concurrency", "resource"].map(capacity => ({ action, reject, capacity }))));
it.each(capacityCases)("retains $capacity after $action until settlement (reject=$reject)", async ({ action, reject, capacity }) => {
    const pending = deferred<NodeSpawnResult>();
    const started: string[] = [];
    let control: GraphControl | undefined;
    const run = runGraph(graph, {}, {
      concurrency: capacity === "concurrency" ? 1 : 2,
      resources: capacity === "resource" ? { exclusive: { capacity: 1 } } : {},
      onControl: value => { control = value; },
      host: { spawnAgent: async request => { started.push(request.nodeId); return started.length === 1 ? pending.promise : { ok: true }; } },
    });
    await vi.waitFor(() => expect(started).toEqual(["a"]));
    expect(control?.[action](0)).toBe(true);
    await setImmediate();
    const beforeDrain = [...started];
    if (reject) pending.reject(new Error("host failure")); else pending.resolve({ ok: true });
    const result = await run;
    if (action === "retry") expect(result.nodes.a).toMatchObject({ activation: 1, graphAttempt: 2, attempt: 2 });
    expect(beforeDrain).toEqual(["a"]);
    expect(started).toEqual(action === "retry" ? ["a", "a", "b"] : ["a", "b"]);
});

it.each((["agent", "validation", "human"] as const).flatMap(kind => [false, true].map(reject => ({ kind, reject }))))("whole-run abort drains pending $kind and blocks follow-up (reject=$reject)", async ({ kind, reject }) => {
  const pending = deferred<NodeSpawnResult>();
  const admitted = deferred<void>();
  const controller = new AbortController();
  const spawn = vi.fn(async () => {
    if (kind === "agent") { admitted.resolve(); return pending.promise; }
    return { ok: true };
  });
  const run = runGraph({ nodes: {
    a: kind === "human" ? { type: "human_gate", prompt: "fixture", outputSchema: { type: "object" } } : { type: "agent", agent: "worker", prompt: "fixture", ...(kind === "validation" ? { validation: { gate: "true" } } : {}) },
    b: { type: "agent", agent: "worker", prompt: "fixture" },
  }, edges: [{ from: "a", to: "b" }] }, {}, {
    signal: controller.signal, host: { spawnAgent: spawn,
      runGate: async () => { admitted.resolve(); await pending.promise; return { ok: true, output: "" }; },
      awaitHumanGate: async () => { admitted.resolve(); return pending.promise; },
    },
  });
  await admitted.promise;
  let finished = false;
  void run.then(() => { finished = true; });
  controller.abort();
  await setImmediate();
  const finishedBeforeDrain = finished;
  if (reject) pending.reject(new Error("host failure")); else pending.resolve({ ok: true, output: "{}" });
  expect((await run).status).toBe("aborted");
  expect(finishedBeforeDrain).toBe(false);
  expect(spawn).toHaveBeenCalledTimes(kind === "human" ? 0 : 1);
});

it("skip preserves the existing human-gate drain boundary", async () => {
  const pending = deferred<NodeSpawnResult>();
  let control: GraphControl | undefined;
  let finished = false;
  const run = runGraph({ nodes: { gate: { type: "human_gate", prompt: "fixture", outputSchema: { type: "object" } } }, edges: [] }, {}, {
    onControl: value => { control = value; }, host: { spawnAgent: async () => ({ ok: true }), awaitHumanGate: () => pending.promise },
  }).then(result => { finished = true; return result; });
  await vi.waitFor(() => expect(control).toBeDefined());
  expect(control?.skip(0)).toBe(true);
  await setImmediate();
  expect(finished).toBe(false);
  pending.resolve({ ok: true, output: "{}" });
  expect((await run).nodes.gate.status).toBe("skipped");
});

it("blocks accounting and gates when the host aborts the run before returning", async () => {
  const controller = new AbortController();
  const gate = vi.fn(async () => ({ ok: true, output: "" }));
  const run = await runGraph({ version: 2, nodes: { a: { type: "agent", agent: "worker", prompt: "fixture", validation: { gate: "true" } } }, edges: [] }, {}, {
    signal: controller.signal, onCheckpoint: () => {},
    host: { spawnAgent: async () => { controller.abort(); return { ok: true, costUsd: 1 }; }, runGate: gate },
  });
  expect(run.status).toBe("aborted");
  expect(run.nodes.a.costUsd).toBeUndefined();
  expect(gate).not.toHaveBeenCalled();
});
