import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createActor, toPromise } from "xstate";
import { graphLogic } from "../src/graph/graph-actor.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeSpawnResult } from "../src/graph/node-host.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const worker = { type: "agent", agent: "worker", prompt: "fixture" } as const;
const graph: AgentGraph = { version: 2, nodes: { a: worker, b: worker }, edges: [] };
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Missing resolver"); };
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { resolve, promise };
}

describe("GraphActor root authority", () => {
  it("checkpoints one admission wave and one delayed settlement batch before terminal", async () => {
    const frames: SchedulerState[] = [];
    const states: string[] = [];
    const a = deferred<NodeSpawnResult>(); const b = deferred<NodeSpawnResult>();
    let count = 0;
    const actor = createActor(graphLogic, { input: { graph, input: {}, depth: 0, options: {
      onCheckpoint: state => frames.push(state), host: { spawnAgent: () => ++count === 1 ? a.promise : b.promise },
    } } });
    actor.subscribe(snapshot => states.push(JSON.stringify(snapshot.value)));
    const completed = toPromise(actor); actor.start();
    await vi.waitFor(() => expect(count).toBe(2));
    expect(frames).toHaveLength(2);
    expect(Object.keys(actor.getSnapshot().children).filter(id => id.startsWith("node:"))).toHaveLength(2);
    a.resolve({ ok: true }); b.resolve({ ok: true });
    await Promise.resolve();
    expect(frames).toHaveLength(2);
    expect((await completed).status).toBe("completed");
    expect(frames).toHaveLength(4);
    expect(states.some(state => state.includes("initializing"))).toBe(true);
    expect(states.some(state => state.includes("persisting"))).toBe(true);
    expect(states.at(-1)).toBe('"terminal"');
  });

  it("rejects reentrant persistence controls without queued mutation, and skips while paused", async () => {
    const pending = deferred<NodeSpawnResult>(); let control: GraphControl | undefined;
    const attempts: boolean[] = []; const frames: SchedulerState[] = [];
    const run = runGraph(graph, {}, { concurrency: 1, host: { spawnAgent: () => pending.promise },
      onControl: value => { control = value; }, onCheckpoint: state => {
        frames.push(state); if (control) attempts.push(control.skip(1));
      },
    });
    await vi.waitFor(() => expect(frames.at(-1)?.nodes.a.status).toBe("running"));
    expect(attempts).toEqual([false]);
    if (!control) throw new Error("Missing control");
    control.pause(); expect(control.isPaused()).toBe(true);
    expect(control.skip(1)).toBe(true);
    await vi.waitFor(() => expect(frames.at(-1)?.nodes.b.status).toBe("skipped"));
    pending.resolve({ ok: true });
    await setImmediate(); control.resume();
    expect((await run).nodes.b).toMatchObject({ status: "skipped", attempt: 0 });
    expect(attempts.every(value => !value)).toBe(true);
  });

  it("latches the exact infrastructure error and drains a noncooperative sibling before rejecting", async () => {
    const pending = deferred<NodeSpawnResult>(); const first = deferred<NodeSpawnResult>();
    const error = new Error("checkpoint failure"); let calls = 0; let aborted = false; let finished = false;
    const run = runGraph(graph, {}, { onCheckpoint: state => {
      if (state.nodes.a.status === "completed") throw error;
    }, host: { spawnAgent: (_request, signal) => {
      calls++; signal.addEventListener("abort", () => { aborted = true; }); return calls === 1 ? first.promise : pending.promise;
    } } }).then(() => { finished = true; return undefined; }, failure => { finished = true; return failure; });
    await vi.waitFor(() => expect(calls).toBe(2)); first.resolve({ ok: true });
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(finished).toBe(false); pending.resolve({ ok: true });
    expect(await run).toBe(error);
  });

  it("reconciles cancellation during initialization before any publication or dispatch", async () => {
    let saved: SchedulerState | undefined;
    await runGraph({ ...graph, nodes: { a: worker } }, {}, { onCheckpoint: state => { if (state.nodes.a.status === "running") saved ??= state; }, host: { spawnAgent: async () => ({ ok: true }) } });
    if (!saved) throw new Error("Missing admitted checkpoint");
    const reconciled = deferred<boolean>(); const controller = new AbortController(); const published = vi.fn(); const spawnAgent = vi.fn();
    const run = runGraph({ ...graph, nodes: { a: worker } }, {}, { restore: saved, signal: controller.signal, reclaimedDeadWriter: true,
      onCheckpoint: () => {}, onNodeAdded: published, host: { spawnAgent, reconcileDrain: () => reconciled.promise },
    });
    controller.abort(); await setImmediate(); expect(published).not.toHaveBeenCalled();
    reconciled.resolve(true); expect((await run).status).toBe("aborted"); expect(spawnAgent).not.toHaveBeenCalled();
  });
});

it("holds newly expanded work when admission publication pauses an existing wave", async () => {
  let control: GraphControl | undefined; const started: string[] = [];
  const run = runGraph({ version: 2, nodes: { before: { ...worker, agent: "before" }, expand: { type: "expand", source: { path: "$" } } }, edges: [] },
    { nodes: { after: { ...worker, agent: "after" } }, edges: [] }, {
      onCheckpoint: () => {}, onControl: value => { control = value; },
      onNodeAdded: id => { if (id === "after") control?.pause(); },
      host: { spawnAgent: async request => { started.push(request.agentType); return { ok: true }; } },
    });
  await vi.waitFor(() => expect(control?.isPaused()).toBe(true));
  await setImmediate(); expect(started).toEqual(["before"]);
  control?.resume(); expect((await run).status).toBe("completed");
  expect(started).toEqual(["before", "after"]);
});

it("preserves empty outputs for non-durable cancellation after partial completion", async () => {
  const controller = new AbortController(); let calls = 0;
  const result = await runGraph({ nodes: { a: worker, b: worker }, edges: [{ from: "a", to: "b" }], outputs: { result: { node: "a", path: "$" } } }, {}, {
    signal: controller.signal, host: { spawnAgent: async () => { if (++calls === 2) controller.abort(); return { ok: true, output: "partial" }; } },
  });
  expect(result.status).toBe("aborted"); expect(result.outputs).toEqual({});
});

it.each(["skip", "retry"] as const)("drains an admission cancelled by %s publication before dispatch", async kind => {
  const frames: SchedulerState[] = []; let control: GraphControl | undefined; let accepted: boolean | undefined;
  const spawnAgent = vi.fn(async () => ({ ok: true }));
  const result = await runGraph({ ...graph, nodes: { a: worker } }, {}, {
    host: { spawnAgent }, onCheckpoint: state => { frames.push(state); }, onControl: value => { control = value; },
    onNodeUpdate: (_id, node) => { if (node.status === "running" && accepted === undefined) accepted = control?.[kind](0); },
  });
  expect(accepted).toBe(true);
  expect(spawnAgent).toHaveBeenCalledTimes(kind === "skip" ? 0 : 1);
  expect(result.nodes.a.status).toBe(kind === "skip" ? "skipped" : "completed");
  const ledger = frames.at(-1)?.runtime?.executionLedger?.filter(row => "payload" in row) ?? [];
  const cancelled = ledger.find(row => row.payload.kind === "cancel-requested");
  expect(cancelled?.payload).toMatchObject({ kind: "cancel-requested", reason: kind });
  expect(ledger.filter(row => row.executionAttemptId === cancelled?.executionAttemptId).map(row => row.payload.kind)).toEqual(["admitted", "dispatched", "cancel-requested", "outcome", "drain-ack"]);
});

it.each(["checkpoint", "publication"] as const)("durably drains whole-run abort from admission %s without dispatch", async boundary => {
  const controller = new AbortController(); const frames: SchedulerState[] = [];
  const spawnAgent = vi.fn(async () => ({ ok: true }));
  const result = await runGraph({ ...graph, nodes: { a: worker } }, {}, {
    signal: controller.signal, host: { spawnAgent },
    onCheckpoint: state => { frames.push(state); if (boundary === "checkpoint" && state.nodes.a.status === "running") controller.abort(); },
    onNodeUpdate: (_id, node) => { if (boundary === "publication" && node.status === "running") controller.abort(); },
  });
  expect(result.status).toBe("aborted"); expect(spawnAgent).not.toHaveBeenCalled();
  expect(frames.at(-1)?.runtime?.executionLedger?.filter(row => "payload" in row).map(row => row.payload.kind)).toEqual(["admitted", "dispatched", "cancel-requested", "outcome", "drain-ack"]);
});

it("drains the existing child when the second-attempt checkpoint fails before ACK", async () => {
  const error = new Error("second admission failed"); const spawnAgent = vi.fn(async () => ({ ok: false }));
  const actor = createActor(graphLogic, { input: { graph: { ...graph, nodes: { a: { ...worker, retry: { maxAttempts: 2 } } } }, input: {}, depth: 0, options: {
    host: { spawnAgent }, onCheckpoint: state => {
      if (state.runtime?.executionLedger?.filter(row => "payload" in row && row.payload.kind === "admitted").length === 2) throw error;
    },
  } } });
  const completion = toPromise(actor); actor.start();
  await expect(completion).rejects.toBe(error);
  expect(spawnAgent).toHaveBeenCalledTimes(1);
  expect(Object.keys(actor.getSnapshot().children).filter(id => id.startsWith("node:"))).toEqual([]);
});

it.each(["repair", "attempt"] as const)("commits the %s ACK before cancellation drains the current identity", async boundary => {
  const frames: SchedulerState[] = []; const controller = new AbortController();
  const spawnAgent = vi.fn(async () => ({ ok: false }));
  const result = await runGraph({ ...graph, nodes: { a: { ...worker, retry: { maxAttempts: 2 } } } }, {}, {
    signal: controller.signal, host: { spawnAgent }, onCheckpoint: state => {
      frames.push(state); const ledger = state.runtime?.executionLedger?.filter(row => "payload" in row) ?? [];
      if (boundary === "attempt" ? ledger.filter(row => row.payload.kind === "admitted").length === 2 : ledger.some(row => row.payload.kind === "drain-ack")) controller.abort();
    },
  });
  expect(result.status).toBe("aborted"); expect(spawnAgent).toHaveBeenCalledTimes(1);
  const ledger = frames.at(-1)?.runtime?.executionLedger?.filter(row => "payload" in row) ?? [];
  const current = ledger.filter(row => row.payload.kind === "admitted").at(-1);
  expect(current).toBeDefined();
  expect(ledger.filter(row => row.executionAttemptId === current?.executionAttemptId).map(row => row.payload.kind)).toContain("drain-ack");
});

it.each(["checkpoint", "publication"] as const)("rejects admission %s failure without host dispatch", async boundary => {
  const error = new Error("admission failed"); const spawnAgent = vi.fn(async () => ({ ok: true }));
  let failed = false; let children = 0;
  const actor = createActor(graphLogic, { input: { graph: { ...graph, nodes: { a: worker } }, input: {}, depth: 0, options: {
    host: { spawnAgent }, onCheckpoint: state => {
      expect(failed).toBe(false);
      if (boundary === "checkpoint" && state.nodes.a.status === "running") { failed = true; throw error; }
    },
    onNodeUpdate: (_id, node) => { if (boundary === "publication" && node.status === "running") { failed = true; throw error; } },
  } } });
  actor.subscribe({ next: snapshot => { children = Math.max(children, Object.keys(snapshot.children).filter(id => id.startsWith("node:")).length); }, error: () => {} });
  const completion = toPromise(actor); actor.start();
  await expect(completion).rejects.toBe(error); expect(spawnAgent).not.toHaveBeenCalled();
  expect(children).toBe(0);
  expect(Object.keys(actor.getSnapshot().children).filter(id => id.startsWith("node:"))).toEqual([]);
});

it.each([false, true])("persists global cancellation before spawning queued children (writer failure: %s)", async failCancel => {
  const error = new Error("cancel checkpoint failed"); const frames: SchedulerState[] = []; const order: string[] = [];
  const spawnAgent = vi.fn(async () => ({ ok: true }));
  const actor = createActor(graphLogic, { input: { graph: { ...graph, nodes: { a: worker } }, input: {}, depth: 0, options: {
    host: { spawnAgent }, onCheckpoint: state => {
      const ledger = state.runtime?.executionLedger?.filter(row => "payload" in row) ?? [];
      if (ledger.some(row => row.payload.kind === "cancel-requested") && !ledger.some(row => row.payload.kind === "drain-ack")) {
        order.push("cancel"); if (failCancel) throw error;
      }
      frames.push(state);
    },
    onNodeUpdate: (_id, node) => { if (node.status === "running") actor.send({ type: "CANCEL" }); },
  } } });
  actor.subscribe({ next: snapshot => { if (snapshot.children["node:a"] && !order.includes("child")) order.push("child"); }, error: () => {} });
  const completion = toPromise(actor); actor.start();
  if (failCancel) await expect(completion).rejects.toBe(error);
  else {
    expect((await completion).status).toBe("aborted");
    expect(frames.at(-1)?.runtime?.executionLedger?.filter(row => "payload" in row).map(row => row.payload.kind)).toEqual(["admitted", "dispatched", "cancel-requested", "outcome", "drain-ack"]);
  }
  // One atomic cancellation checkpoint commits feedback and leaf facts before child creation.
  expect(order).toEqual(failCancel ? ["cancel"] : ["cancel", "child"]);
  expect(spawnAgent).not.toHaveBeenCalled();
});

it.each(["skip", "retry"] as const)("rejects reentrant %s during the atomic repair checkpoint", async kind => {
  let control: GraphControl | undefined; let saved: SchedulerState | undefined; let accepted: boolean | undefined;
  const spawnAgent = vi.fn(async () => ({ ok: spawnAgent.mock.calls.length === 2 }));
  const result = await runGraph({ ...graph, nodes: { a: { ...worker, retry: { maxAttempts: 2 } } } }, {}, {
    host: { spawnAgent }, onControl: value => { control = value; }, onCheckpoint: state => {
      saved = state;
      if (accepted === undefined && state.runtime?.executionLedger?.filter(row => "payload" in row && row.payload.kind === "admitted").length === 2) accepted = control?.[kind](0);
    },
  });
  expect(accepted).toBe(false); expect(result.nodes.a).toMatchObject({ status: "completed", attempt: 1 });
  expect(spawnAgent).toHaveBeenCalledTimes(2);
  expect(saved?.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "cancel-requested")).toBe(false);
});

it.each(["skip", "retry"] as const)("drains a validation-gate request queued behind %s without root failure", async kind => {
  let control: GraphControl | undefined; const accepted: boolean[] = []; let saved: SchedulerState | undefined;
  const spawnAgent = vi.fn(async () => {
    if (spawnAgent.mock.calls.length === 1 && control) { accepted.push(control[kind](0), control[kind](0)); }
    return { ok: true };
  });
  const runGate = vi.fn(async () => ({ ok: true, output: "" }));
  const result = await runGraph({ ...graph, nodes: { a: { ...worker, validation: { gate: "true" } } } }, {}, {
    host: { spawnAgent, runGate }, onCheckpoint: state => { saved = state; }, onControl: value => { control = value; },
  });
  expect(accepted).toEqual([true, true]);
  expect(result.nodes.a.status).toBe(kind === "skip" ? "skipped" : "completed");
  expect(spawnAgent).toHaveBeenCalledTimes(kind === "skip" ? 1 : 2); expect(runGate).toHaveBeenCalledTimes(kind === "skip" ? 0 : 1);
  const ledger = saved?.runtime?.executionLedger?.filter(row => "payload" in row) ?? [];
  const cancelled = ledger.find(row => row.payload.kind === "cancel-requested");
  expect(cancelled?.payload).toMatchObject({ kind: "cancel-requested", reason: kind });
  expect(ledger.filter(row => row.executionAttemptId === cancelled?.executionAttemptId).map(row => row.payload.kind)).toEqual(["admitted", "dispatched", "cancel-requested", "outcome", "drain-ack"]);
});
