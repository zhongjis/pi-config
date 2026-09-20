import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createActor, toPromise } from "xstate";
import { type GraphActor, graphLogic } from "../src/graph/graph-actor.js";
import type { NodeRequest } from "../src/graph/node-protocol.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture(kind: "gate" | "repair" = "gate") {
  const frames: SchedulerState[] = []; const deliveries: string[] = []; const resolved = vi.fn();
  let release: (() => void) | undefined; let failure: unknown; let spawns = 0;
  const physical = () => new Promise<void>(resolve => { release = resolve; });
  const actor: GraphActor = createActor(graphLogic, {
    inspect: event => {
      if (event.type === "@xstate.event" && event.event.type === "NODE.ACK") deliveries.push("ack");
    },
    input: { graph: { version: 2, nodes: { a: { type: "agent", agent: "worker", prompt: "fixture", retry: { maxAttempts: 3 }, ...(kind === "gate" ? { validation: { gate: "check" } } : {}) } }, edges: [] }, input: {}, depth: 0,
      options: { onNodeResolved: resolved, onCheckpoint: state => { frames.push(state); deliveries.push("checkpoint"); }, host: {
        spawnAgent: async () => { if (kind === "repair" && ++spawns > 1) await physical(); return { ok: kind === "gate" }; },
        runGate: async () => { await physical(); return { ok: true, output: "" }; },
      } } },
  });
  actor.subscribe({ error: error => { failure = error; } }); actor.start();
  cleanups.push(() => { actor.stop(); release?.(); });
  await vi.waitFor(() => expect(release).toBeDefined()); actor.send({ type: "PAUSE" });
  const journal = actor.getSnapshot().context.journals.get("a");
  const child = actor.getSnapshot().children["node:a"];
  if (!journal || !child) throw new TypeError("Missing typed child");
  // The first operation is retained in the child's immutable journal, and the root ACK echoes it.
  const correlation = frames.find(state => state.runtime?.executionLedger?.length)?.runtime?.executionLedger?.find(row => "payload" in row && row.payload.kind === "admitted");
  if (!correlation || !("payload" in correlation)) throw new TypeError("Missing admission");
  const request: NodeRequest = { type: "NODE.REQUEST", id: "a", incarnation: journal.receipt.incarnation,
    correlation: { runId: correlation.runId, instanceId: correlation.instanceId, activation: correlation.activation, graphAttempt: correlation.graphAttempt, executionAttemptId: correlation.executionAttemptId }, requestSequence: 1,
    operation: kind === "gate" ? { kind: "gate", costUsd: undefined } : { kind: "repair", result: { ok: false }, executed: true } };
  return { actor, frames, deliveries, resolved, journal, request, release: () => release?.(), failure: () => failure };
}
it.each(["gate", "repair"] as const)("replays committed %s ACK without mutation or checkpoint", async kind => {
  const run = await fixture(kind); const before = structuredClone(run.actor.getSnapshot().context.domain?.instances.state); const writes = run.frames.length;
  expect(run.deliveries.indexOf("checkpoint")).toBeLessThan(run.deliveries.indexOf("ack"));
  run.deliveries.length = 0; run.actor.send(structuredClone(run.request)); await setImmediate();
  expect(run.deliveries).toEqual(["ack"]); expect(run.frames).toHaveLength(writes);
  expect(run.actor.getSnapshot().context.domain?.instances.state).toEqual(before);
});
it("replays committed ACK during cancellation without deadlock or checkpoint", async () => {
  const run = await fixture(); run.actor.send({ type: "CANCEL" });
  await vi.waitFor(() => expect(run.actor.getSnapshot().matches({ active: { lifecycle: "drainWaiting" } })).toBe(true));
  const writes = run.frames.length; run.deliveries.length = 0;
  run.actor.send(structuredClone(run.request)); await setImmediate();
  expect(run.deliveries).toEqual(["ack"]); expect(run.frames).toHaveLength(writes);
  const result = toPromise(run.actor); run.release(); expect((await result).status).toBe("aborted");
});
it.each(["conflict", "gap", "stale", "incarnation"] as const)("fails closed on %s but retains physical ownership", async kind => {
  const run = await fixture(); const request = run.request;
  const invalid = kind === "conflict" ? { ...request, operation: { kind: "gate" as const, costUsd: 2 } } : kind === "gap" ? { ...request, requestSequence: 3 } : kind === "incarnation" ? { ...request, incarnation: "other" } : { ...request, requestSequence: 2, correlation: { ...request.correlation, graphAttempt: 99 } };
  run.actor.send(invalid); const first = run.actor.getSnapshot().context.failure?.error;
  expect(first).toBeInstanceOf(TypeError); run.actor.send({ type: "FAIL", error: new Error("later") });
  run.actor.send({ ...request, type: "NODE.DRAINED", incarnation: "stale", failure: { error: first } });
  await setImmediate(); expect(run.failure()).toBeUndefined(); expect(run.actor.getSnapshot().children["node:a"]).toBeDefined();
  run.release(); await vi.waitFor(() => expect(run.failure()).toBe(first));
});

it("suppresses stale resolution incarnation and execution without accounting", async () => {
  const run = await fixture(); const before = run.frames.length;
  const event = { ...run.request, type: "NODE.RESOLVED" as const, info: { modelName: "fixture" } };
  run.actor.send({ ...event, incarnation: "stale" });
  run.actor.send({ ...event, correlation: { ...event.correlation, graphAttempt: 99 } });
  run.actor.send(event); await setImmediate();
  expect(run.resolved).toHaveBeenCalledTimes(1); expect(run.frames).toHaveLength(before);
});
