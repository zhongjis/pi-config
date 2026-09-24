import { describe, expect, it } from "vitest";
import { GraphInstances } from "../src/graph/graph-instance-id.js";
import { canMaterialize, collectionProposal, hasCapacity, isDone, loopProposal, type PlanningView, readyNodes, resolutionContext, resolveOutputs, restoreProposal, runStatus, skipProposal, transitionProposal } from "../src/graph/graph-planner.js";
import { GraphProjection } from "../src/graph/graph-planning-view.js";
import { applyProjection, parseProjection, snapshotProjection } from "../src/graph/graph-projection.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import * as scheduler from "../src/graph/scheduler.js";

const agent = { type: "agent", agent: "x", prompt: "p" } as const;
function freeze(value: unknown): void {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
}
const graph: AgentGraph = { nodes: { a: agent, b: agent, c: agent }, edges: [{ from: "a", to: "b" }, { from: "b", to: "a", loop: { maxIterations: 1 } }, { from: "b", to: "c" }], outputs: { result: { node: "a", path: "$" } } };

describe("pure Panda planning", () => {
  it("leaves frozen projection/topology untouched across every query and proposal", () => {
    const state: SchedulerState = { nodes: { a: { status: "completed", attempt: 1, output: 7 }, b: { status: "running", attempt: 1 }, c: { status: "pending", attempt: 0 } }, loopCounts: {} };
    const view: PlanningView = { state, graph: structuredClone(graph), input: {} };
    const before = structuredClone(view); freeze(view);
    expect(readyNodes(view)).toEqual([]);
    resolutionContext(view); skipProposal(view); skipProposal(view, true); loopProposal(view, "a");
    collectionProposal(view); restoreProposal(state); snapshotProjection(state); parseProjection(view.graph, state);
    expect(resolveOutputs(view)).toEqual({ result: 7 });
    expect(runStatus(state)).toBe("completed"); expect(isDone(state)).toBe(false);
    expect(canMaterialize(view, 997)).toBe(true); expect(canMaterialize(view, 998)).toBe(false);
    expect(hasCapacity(2, 2)).toBe(false); expect(hasCapacity(2, undefined)).toBe(true);
    transitionProposal(view, { kind: "settle", id: "b", result: { ok: true, output: 8 } });
    transitionProposal(view, { kind: "retry", id: "b" });
    transitionProposal(view, { kind: "start", id: "c", executionIdentity: true });
    expect(view).toEqual(before);
  });

  it("applies selected completion and bounded reactivation without changing the original evidence", () => {
    const state: SchedulerState = { nodes: { a: { status: "completed", attempt: 1, output: 7 }, b: { status: "running", attempt: 1 }, c: { status: "pending", attempt: 0 } }, loopCounts: {} };
    const view = { state, graph, input: {} };
    const before = structuredClone(state);
    const intent = transitionProposal(view, { kind: "settle", id: "b", result: { ok: true, output: 8 } });
    expect(state).toEqual(before);
    applyProjection(state, intent);
    expect(state.nodes.a).toEqual({ status: "pending", attempt: 1, output: undefined, attemptReason: "loop" });
    expect(state.loopCounts).toEqual({ "b->a": 1 });
    expect(readyNodes(view)).toEqual(["a", "c"]);
    applyProjection(state, transitionProposal(view, { kind: "start", id: "a", executionIdentity: true }));
    expect(state.nodes.a).toMatchObject({ attempt: 2, activation: 2, graphAttempt: 1 });
  });

  it("preserves sequential self-loop status checks and the global backstop", () => {
    const state: SchedulerState = { nodes: { a: { status: "running", attempt: 1000 }, b: { status: "completed", attempt: 1 } }, loopCounts: {} };
    const view = { state, graph: { nodes: { a: agent, b: agent }, edges: [{ from: "a", to: "a", loop: { maxIterations: 1 } }, { from: "a", to: "b" }] }, input: {} };
    applyProjection(state, transitionProposal(view, { kind: "settle", id: "a", result: { ok: true } }));
    expect(state.nodes.b.status).toBe("completed");
    expect(() => transitionProposal(view, { kind: "start", id: "a" })).toThrow("exceeded 1000");
    expect(transitionProposal(view, { kind: "start", id: "a", restored: true })).toMatchObject({ nodes: { a: { attempt: 1000 } } });
  });

  it("proposes an ordered cascading skip batch without hiding writes in readiness", () => {
    const state: SchedulerState = { nodes: { a: { status: "failed", attempt: 1 }, b: { status: "pending", attempt: 0 }, c: { status: "pending", attempt: 0 } }, loopCounts: {} };
    const view = { state, graph, input: {} };
    expect(readyNodes(view)).toEqual([]);
    const intent = skipProposal(view);
    expect(state.nodes.c.status).toBe("pending");
    applyProjection(state, intent);
    expect(Object.values(state.nodes).map(run => run.status)).toEqual(["failed", "skipped", "skipped"]);
  });

  it("aggregates collections in input order and keeps owned failures out of graph failure", () => {
    const state: SchedulerState = { nodes: { owner: { status: "running", attempt: 1 }, first: { status: "failed", attempt: 2, error: "bad" }, second: { status: "completed", attempt: 1, output: 9 } }, loopCounts: {}, collections: { owner: [{ nodeId: "second", item: 0 }, { nodeId: "first", item: 1 }] } };
    const view = { state, graph: { nodes: {}, edges: [] }, input: {} };
    const proposal = collectionProposal(view);
    expect(state.nodes.owner.status).toBe("running");
    expect(proposal.completed).toEqual(["owner"]);
    applyProjection(state, proposal.intent);
    expect(state.nodes.owner.output).toEqual({ results: [{ nodeId: "second", item: 0, index: 0, status: "completed", attempt: 1, output: 9 }, { nodeId: "first", item: 1, index: 1, status: "failed", attempt: 2, error: "bad" }] });
    expect(runStatus(state)).toBe("completed");
  });

  it("parses restore evidence exactly and selects interrupted work separately", () => {
    const saved: SchedulerState = { nodes: { a: { status: "running", attempt: 2, attemptReason: "user-retry", activation: 1, graphAttempt: 2 } }, loopCounts: { "a->a": 1 } };
    const parsed = parseProjection({ nodes: { a: agent }, edges: [] }, saved);
    expect(parsed).toEqual(saved); expect(parsed).not.toBe(saved);
    const intent = restoreProposal(parsed);
    expect(parsed.nodes.a.status).toBe("running"); applyProjection(parsed, intent);
    expect(parsed.nodes.a).toEqual({ ...saved.nodes.a, status: "pending" });
    expect(saved.nodes.a.status).toBe("running");
  });

  it("treats prototype names as bindings, never inherited feedback or materialization ownership", () => {
    const runtime = new GraphInstances("agr_projection").state; runtime.feedback = {};
    const state: SchedulerState = { nodes: {}, loopCounts: {}, runtime };
    applyProjection(state, { kind: "materialize", ids: ["constructor", "__proto__"] });
    expect(Object.keys(state.nodes)).toEqual(["constructor", "__proto__"]);
    applyProjection(state, restoreProposal(state));
    expect(state.nodes.constructor).toEqual({ status: "pending", attempt: 0 });
    const view = { state, graph: { nodes: {}, edges: [] }, input: {} };
    applyProjection(state, transitionProposal(view, { kind: "start", id: "constructor" }));
    applyProjection(state, restoreProposal(state));
    expect(state.nodes.constructor).toEqual({ status: "pending", attempt: 1 });
    expect(Object.getPrototypeOf(state.nodes)).toBe(Object.prototype);
  });

  it("preserves dynamic numeric binding and collection insertion order", () => {
    const projection = new GraphProjection({ nodes: { original: agent }, edges: [] }, {});
    projection.apply({ kind: "materialize", ids: ["20"] });
    projection.apply({ kind: "materialize", ids: ["3"] });
    expect(projection.ready()).toEqual(["original", "20", "3"]);
    expect(skipProposal(projection.view(), true).skipped).toEqual(["original", "20", "3"]);
    for (const id of ["20", "3"]) {
      projection.apply(transitionProposal(projection.view(), { kind: "start", id }));
      projection.apply({ kind: "collection", id, children: [] });
    }
    expect(collectionProposal(projection.view()).completed).toEqual(["20", "3"]);
  });

  it("retains active collection ownership while selecting interrupted child restore", () => {
    const state: SchedulerState = { nodes: { owner: { status: "running", attempt: 1 }, child: { status: "running", attempt: 2 } }, loopCounts: {}, collections: { owner: [{ nodeId: "child", item: 0 }] } };
    applyProjection(state, restoreProposal(state));
    expect(state.nodes.owner.status).toBe("running");
    expect(state.nodes.child).toEqual({ status: "pending", attempt: 2 });
  });

  it("keeps retry in the same activation and advances its graph attempt only on admission", () => {
    const state: SchedulerState = { nodes: { a: { status: "running", attempt: 1, activation: 1, graphAttempt: 1, output: 8, error: "old" } }, loopCounts: {} };
    const view = { state, graph, input: {} };
    applyProjection(state, transitionProposal(view, { kind: "retry", id: "a" }));
    expect(state.nodes.a).toEqual({ status: "pending", attempt: 1, activation: 1, graphAttempt: 1, attemptReason: "user-retry", output: undefined, error: undefined });
    applyProjection(state, transitionProposal(view, { kind: "start", id: "a", executionIdentity: true }));
    expect(state.nodes.a).toMatchObject({ status: "running", attempt: 2, activation: 1, graphAttempt: 2 });
  });

  it("exports no Scheduler and gives the projection facade no lifecycle-selection methods", () => {
    expect(Object.keys(scheduler)).toEqual([]);
    const projection = new GraphProjection(graph, {});
    for (const method of ["markRunning", "retry", "settle", "recordCost", "resolveSkips", "forceSkipStuck", "settleCollections", "hydrate"]) expect(method in projection).toBe(false);
    applyProjection(projection.state, { kind: "materialize", ids: ["dynamic"] });
    expect(projection.nodes.get("dynamic")).toBe(projection.state.nodes.dynamic);
  });
});
