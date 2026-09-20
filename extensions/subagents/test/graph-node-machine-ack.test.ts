import { expect, it, vi } from "vitest";
import type { NodeAck } from "../src/graph/node-protocol.js";
import { deferred } from "./graph-drain.fixture.js";
import { agentInput, machine, receipt, repaired } from "./graph-node-machine.fixture.js";

const conflicts: readonly { readonly name: string; readonly change: (ack: NodeAck) => NodeAck }[] = [
  { name: "node id", change: ack => ({ ...ack, id: "other" }) },
  { name: "incarnation", change: ack => ({ ...ack, incarnation: "stale" }) },
  { name: "sequence", change: ack => ({ ...ack, requestSequence: ack.requestSequence + 1 }) },
  { name: "operation", change: ack => ({ ...ack, operation: { kind: "cancel", disposition: "skip" } }) },
  { name: "run", change: ack => ({ ...ack, correlation: { ...ack.correlation, runId: "other" } }) },
  { name: "instance", change: ack => ({ ...ack, correlation: { ...ack.correlation, instanceId: receipt().correlation.instanceId } }) },
  { name: "activation", change: ack => ({ ...ack, correlation: { ...ack.correlation, activation: 2 } }) },
  { name: "graph attempt", change: ack => ({ ...ack, correlation: { ...ack.correlation, graphAttempt: 2 } }) },
  { name: "execution attempt", change: ack => ({ ...ack, correlation: { ...ack.correlation, executionAttemptId: receipt().correlation.executionAttemptId } }) },
  { name: "receipt incarnation", change: ack => ({ ...ack, receipt: { ...ack.receipt, incarnation: "other" } }) },
  { name: "receipt execution sequence", change: ack => ({ ...ack, receipt: { ...ack.receipt, executionSequence: 99 } }) },
  { name: "receipt correlation", change: ack => ({ ...ack, receipt: { ...ack.receipt, correlation: receipt().correlation } }) },
];
it.each(conflicts)("fails closed on mismatched ACK $name without dispatching a gate", async ({ change }) => {
  const runGate = vi.fn(async () => ({ ok: true, output: "" }));
  const input = agentInput({ host: { spawnAgent: async () => ({ ok: true }), runGate }, node: { ...agentInput().node, gate: "check" } });
  const actor = machine(input); actor.admit();
  const request = await actor.next("NODE.REQUEST");
  actor.send(change({ ...request, type: "NODE.ACK", receipt: input.receipt }));
  expect((await actor.next("NODE.DRAINED")).failure.error).toBeInstanceOf(TypeError);
  expect(runGate).not.toHaveBeenCalled(); expect(actor.events).toHaveLength(2); actor.parent.stop();
});

it("ignores exact old repair ACKs while a later settlement awaits its own ACK", async () => {
  const spawnAgent = vi.fn(async () => ({ ok: false }));
  const input = agentInput({ host: { spawnAgent }, node: { ...agentInput().node, maxAttempts: 2 } });
  const actor = machine(input); actor.admit();
  const repair = await actor.next("NODE.REQUEST");
  const latest = repaired(input.receipt);
  const ack = actor.ack(repair, latest);
  const settle = await actor.next("NODE.REQUEST", 1);
  actor.send(structuredClone(ack));
  expect(actor.events).toEqual([repair, settle]);
  expect(actor.child.getSnapshot().context.receipt).toEqual(latest);
  expect(spawnAgent).toHaveBeenCalledTimes(2);
  actor.ack(settle, latest);
  expect(await actor.next("NODE.RELEASE_READY")).toMatchObject({ correlation: latest.correlation, requestSequence: 2 });
  actor.parent.stop();
});

it("rejects a changed duplicate ACK and physically drains an active gate", async () => {
  const physical = deferred<{ ok: boolean; output: string }>();
  const entered = deferred<AbortSignal>();
  const input = agentInput({ host: { spawnAgent: async () => ({ ok: true }), runGate: (_command, options) => { entered.resolve(options.signal); return physical.promise; } },
    node: { ...agentInput().node, gate: "check" } });
  const actor = machine(input); actor.admit();
  const request = await actor.next("NODE.REQUEST"); const ack = actor.ack(request);
  const signal = await entered.promise;
  actor.send({ ...ack, operation: { kind: "gate", costUsd: 99 } });
  expect(signal.aborted).toBe(true);
  expect(actor.events).toEqual([request]);
  physical.resolve({ ok: true, output: "" });
  expect((await actor.next("NODE.DRAINED")).failure.error).toBeInstanceOf(TypeError);
  actor.parent.stop();
});

it("requires settlement ACK before release-ready and explicit matching release before finalization", async () => {
  const input = agentInput(); const actor = machine(input); actor.admit();
  const request = await actor.next("NODE.REQUEST");
  expect(actor.events).toEqual([request]);
  expect(actor.child.getSnapshot().status).toBe("active");
  const ack = actor.ack(request);
  expect(await actor.next("NODE.RELEASE_READY")).toMatchObject({ incarnation: input.receipt.incarnation, correlation: input.receipt.correlation, requestSequence: request.requestSequence });
  expect(actor.child.getSnapshot().value).toBe("settledAwaitingRelease");
  actor.send(structuredClone(ack));
  expect(actor.events).toHaveLength(2);
  actor.send({ type: "NODE.RELEASE", receipt: input.receipt });
  expect(actor.child.getSnapshot().status).toBe("done"); actor.parent.stop();
});

it.each(["early", "stale"] as const)("fails closed on %s release", async kind => {
  const input = agentInput(); const actor = machine(input); actor.admit();
  const request = await actor.next("NODE.REQUEST");
  if (kind === "stale") actor.ack(request);
  actor.send({ type: "NODE.RELEASE", receipt: kind === "early" ? input.receipt : { ...input.receipt, incarnation: "stale" } });
  expect((await actor.next("NODE.DRAINED")).failure.error).toBeInstanceOf(TypeError); actor.parent.stop();
});

it("rejects ACK before admission without running a host", async () => {
  const spawnAgent = vi.fn(async () => ({ ok: true }));
  const input = agentInput({ host: { spawnAgent } }); const actor = machine(input);
  actor.send({ type: "NODE.ACK", id: input.receipt.id, incarnation: input.receipt.incarnation, correlation: input.receipt.correlation,
    requestSequence: 1, operation: { kind: "gate", costUsd: undefined }, receipt: input.receipt });
  expect((await actor.next("NODE.DRAINED")).failure.error).toBeInstanceOf(TypeError);
  expect(spawnAgent).not.toHaveBeenCalled(); actor.parent.stop();
});
