import { expect, it, vi } from "vitest";
import { createActor, toPromise } from "xstate";
import { type CoordinatorRequest, CoordinatorRequestJournal } from "../src/graph/coordinator-protocol.js";
import { graphLogic } from "../src/graph/graph-actor.js";
import { createGraphDomain } from "../src/graph/graph-domain.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { AgentGraph, BoundedFeedbackNode } from "../src/graph/ir.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const feedback: BoundedFeedbackNode = {
  type: "bounded_feedback", maxIterations: 2, maxItemsPerIteration: 2, maxTotalItems: 4,
  work: { type: "fanout", items: { path: "$" }, itemSchema: { type: "object" }, dispatch: { path: "$.kind", cases: { work: "worker" } }, prompt: "${item}", outputSchema: { type: "object" } },
  evaluator: { type: "agent", agent: "judge", prompt: "${feedback}" },
};
const graph: AgentGraph = { version: 2, nodes: { f: feedback }, edges: [], outputs: { result: { node: "f", path: "$" } } };
const input = [{ kind: "work" }];
const enough = { decision: "sufficient", gaps: [], tasks: [] };
const more = { decision: "continue", gaps: [{ id: "g", description: "missing" }], tasks: [{ gapId: "g", item: { kind: "work", next: true } }] };
const host = { spawnAgent: async (request: { agentType: string }) => ({ ok: true, output: JSON.stringify(request.agentType === "judge" ? enough : { evidence: true }) }) };
it("commits complete iteration manifests before registration and owns Feedback/Fanout/leaves as siblings", async () => {
  const frames: { state: SchedulerState; graph: AgentGraph }[] = []; const registered: string[] = []; const requests: string[] = []; const spawned: string[] = [];
  const actor = createActor(graphLogic, { input: { graph, input, depth: 0, options: {
    host, concurrency: 1,
    onCheckpoint: (state, graph) => { validateGraphRestore(state, graph, input); frames.push({ state, graph }); },
    onNodeAdded: id => {
      registered.push(id);
      if (id.includes(":iteration:")) {
        const state = frames.at(-1)?.state;
        expect(state?.runtime?.manifest).toHaveLength(4);
        expect(state?.collections?.["f:iteration:1:work"]).toHaveLength(1);
        expect(state?.runtime?.feedback?.f.active?.iteration).toBe(1);
      }
    },
  } }, inspect: event => {
    if (event.type === "@xstate.actor") {
      const id = String(Reflect.get(event.actorRef, "id")); spawned.push(id);
      if (id === "node:f") expect(frames.at(-1)?.state.nodes.f).toMatchObject({ status: "running", attempt: 1 });
    }
    if (event.type === "@xstate.event" && event.event.type === "COORD.REQUEST") {
      const operation: unknown = Reflect.get(event.event, "operation");
      if (operation && typeof operation === "object") requests.push(String(Reflect.get(operation, "kind")));
    }
  } });
  let siblings = false;
  actor.subscribe(snapshot => { if (snapshot.children["node:f"] && snapshot.children["node:f:iteration:1:work"] && snapshot.children["node:f:iteration:1:work:item:0"]) siblings = true; });
  const done = toPromise(actor); actor.start(); expect((await done).status).toBe("completed"); actor.stop();
  expect(siblings).toBe(true);
  expect(requests).toEqual(["feedback-intent", "feedback-materialize", "aggregate", "feedback-decision"]);
  expect(registered).toEqual(["f", "f:iteration:1:work", "f:iteration:1:evaluator", "f:iteration:1:work:item:0"]);
  expect(spawned).toContain("node:f:iteration:1:evaluator");
  const saved = frames.at(-1); if (!saved) throw new TypeError("Missing checkpoint");
  const restoredActors: string[] = [];
  const restored = createActor(graphLogic, { input: { graph: saved.graph, input, depth: 0, options: { restore: saved.state, host, onCheckpoint: () => {} } }, inspect: event => { if (event.type === "@xstate.actor") restoredActors.push(String(Reflect.get(event.actorRef, "id"))); } });
  const resumed = toPromise(restored); restored.start(); await resumed; restored.stop();
  expect(restoredActors.filter(id => id.startsWith("node:"))).toEqual([]);
});
it.each(["intent", "manifest", "decision"])("fails the %s writer without publishing unauthorized topology or terminal facts", async boundary => {
  const error = new Error("writer"); const added: string[] = []; const updates: string[] = []; const spawnAgent = vi.fn(host.spawnAgent);
  await expect(runGraph(graph, input, { host: { spawnAgent }, onNodeAdded: id => { added.push(id); }, onNodeUpdate: (id, run) => { updates.push(`${id}:${run.status}`); }, onCheckpoint: state => {
    const f = state.runtime?.feedback?.f;
    if (boundary === "intent" && f?.intent || boundary === "manifest" && f?.active || boundary === "decision" && f?.terminal) throw error;
  } })).rejects.toBe(error);
  if (boundary !== "decision") { expect(added).toEqual(["f"]); expect(spawnAgent).not.toHaveBeenCalled(); }
  expect(updates).not.toContain("f:completed");
});
it("cancels after decision ACK and before successor allocation", async () => {
  const frames: SchedulerState[] = []; let cancelled = false;
  const actor = createActor(graphLogic, { input: { graph, input, depth: 0, options: {
    host: { spawnAgent: async request => ({ ok: true, output: JSON.stringify(request.agentType === "judge" ? more : { evidence: true }) }) },
    onCheckpoint: (state, graph) => { validateGraphRestore(state, graph, input); frames.push(state); },
  } }, inspect: event => {
    if (event.type === "@xstate.event" && event.event.type === "COORD.ACK") {
      const operation: unknown = Reflect.get(event.event, "operation");
      if (!cancelled && operation && typeof operation === "object" && Reflect.get(operation, "kind") === "feedback-decision") { cancelled = true; actor.send({ type: "CANCEL" }); }
    }
  } });
  const done = toPromise(actor); actor.start(); const result = await done; actor.stop();
  expect(cancelled).toBe(true); expect(result.feedback?.f).toMatchObject({ reason: "cancellation", counters: { iterations: 1 } });
  expect(frames.at(-1)?.runtime?.manifest).toHaveLength(4);
  expect(frames.some(state => state.runtime?.feedback?.f?.intent?.iteration === 2)).toBe(true);
});
it("materializes simultaneous regions despite a full executor, and waits for cancelled leaf drain", async () => {
  let release: (() => void) | undefined; let control: GraphControl | undefined; let settled = false;
  const controller = new AbortController(); const frames: SchedulerState[] = [];
  const definition: AgentGraph = { ...graph, nodes: { busy: { type: "agent", agent: "worker", prompt: "busy" }, f: feedback, g: feedback } };
  const pending = runGraph(definition, input, { concurrency: 1, signal: controller.signal, onControl: value => { control = value; },
    onCheckpoint: (state, graph) => { validateGraphRestore(state, graph, input); frames.push(state); },
    host: { spawnAgent: async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; } },
  });
  void pending.then(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(Object.keys(frames.at(-1)?.collections ?? {})).toHaveLength(2));
    expect(control?.skip(1)).toBe(false); expect(control?.retry(1)).toBe(false);
    controller.abort();
    await vi.waitFor(() => expect(frames.at(-1)?.runtime?.feedback?.g.terminal?.reason).toBe("cancellation"));
    expect(settled).toBe(false);
  } finally { release?.(); }
  expect((await pending).status).toBe("aborted");
});
it("replays committed feedback requests without allocation and rejects conflicting iteration or early decision", () => {
  const domain = createGraphDomain({ graph, input, depth: 0, options: { host, onCheckpoint: () => {} } });
  const admission = domain.plan()[0]; if (admission.kind !== "feedback") throw new TypeError("Missing feedback");
  const journal = new CoordinatorRequestJournal(admission.input.receipt);
  const intent: CoordinatorRequest = { type: "COORD.REQUEST", receipt: admission.input.receipt, requestSequence: 1, operation: { kind: "feedback-intent" } };
  const manifest: CoordinatorRequest = { ...intent, requestSequence: 2, operation: { kind: "feedback-materialize", iteration: 1 } };
  for (const request of [intent, manifest]) {
    expect(journal.receive(request, request.receipt).kind).toBe("apply"); domain.coordinatorRequest(request);
    const ack = { ...request, type: "COORD.ACK" as const }; journal.prepare(ack);
    expect(journal.receive(request, request.receipt).kind).toBe("pending"); journal.commit(ack);
    expect(journal.receive(request, request.receipt)).toEqual({ kind: "replay", ack });
  }
  expect(domain.frames.at(-2)?.state.runtime?.manifest).toHaveLength(1);
  expect(domain.instances.state.manifest).toHaveLength(4);
  expect(() => journal.receive({ ...manifest, operation: { kind: "feedback-materialize", iteration: 2 } }, manifest.receipt)).toThrow(/Conflicting/);
  expect(() => domain.coordinatorRequest({ ...manifest, operation: { kind: "feedback-decision", iteration: 1 } })).toThrow(/Invalid feedback decision/);
});
it.each(["item", "evaluator"] as const)("preserves %s skip/retry controls and physical drain", async target => {
  for (const operation of ["skip", "retry"] as const) {
    let control: GraphControl | undefined; let release: (() => void) | undefined; let calls = 0; let finished = false;
    const pending = runGraph(graph, input, { concurrency: 1, onCheckpoint: () => {}, onControl: value => { control = value; }, host: {
      spawnAgent: async request => {
        if ((request.agentType === "judge") === (target === "evaluator")) {
          calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
        }
        return host.spawnAgent(request);
      },
    } });
    void pending.then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(control?.[operation](target === "item" ? 3 : 2)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(calls).toBe(1); expect(finished).toBe(false);
    } finally { release?.(); }
    const result = await pending;
    expect(calls).toBe(operation === "retry" ? 2 : 1);
    expect(result.feedback?.f.reason).toBe(operation === "retry" ? "sufficient" : target === "item" ? "no progress" : "evaluator failure");
  }
});
