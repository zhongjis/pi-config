import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { HumanGateRequest, NodeSpawnRequest, NodeSpawnResult } from "../src/graph/node-host.js";
import { deferred } from "./graph-drain.fixture.js";
import { agentInput, humanInput, machine, repaired } from "./graph-node-machine.fixture.js";

const kinds = ["agent", "human", "gate"] as const;
function parked(kind: typeof kinds[number]) {
  const physical = deferred<NodeSpawnResult>();
  const entered = deferred<AbortSignal>();
  const spawnAgent = vi.fn(async (_request: NodeSpawnRequest, signal: AbortSignal) => {
    if (kind === "agent") { entered.resolve(signal); return physical.promise; }
    return { ok: true, costUsd: 0.4 };
  });
  const runGate = vi.fn(async (_command: string, options: { signal: AbortSignal }) => {
    entered.resolve(options.signal); await physical.promise; return { ok: false, output: "gate failed" };
  });
  const awaitHumanGate = vi.fn(async (_request: HumanGateRequest, signal: AbortSignal) => { entered.resolve(signal); return physical.promise; });
  const host = { spawnAgent, runGate, awaitHumanGate };
  const input = kind === "human" ? humanInput({ host }) : agentInput({ host, node: { ...agentInput().node, gate: "check", maxAttempts: 3 } });
  const actor = machine(input);
  actor.admit();
  return { actor, input, physical, entered, spawnAgent, runGate };
}

it.each(kinds)("ACKs cancellation before abort and retains noncooperative %s invoke until physical drain", async kind => {
  const { actor, physical, entered } = parked(kind);
  if (kind === "gate") actor.ack(await actor.next("NODE.REQUEST"));
  const signal = await entered.promise;
  const offset = actor.events.length;
  const reason = { reason: "arbitrary abort value" };
  actor.send({ type: "CANCEL", disposition: "retry", reason });
  const cancel = await actor.next("NODE.REQUEST", offset);
  expect(cancel.operation).toEqual({ kind: "cancel", disposition: "retry" });
  expect(signal.aborted).toBe(false);
  actor.ack(cancel);
  expect(signal.reason).toBe(reason);
  await setImmediate();
  expect(actor.events).toHaveLength(offset + 1);
  expect(actor.child.getSnapshot().context.active).toBe(true);
  physical.resolve({ ok: true, costUsd: 99 });
  const settle = await actor.next("NODE.REQUEST", offset + 1);
  expect(settle.operation).toMatchObject({ kind: "settle", cancelled: true, projection: "retry", result: { ok: false, skipped: true } });
  if (settle.operation.kind !== "settle") throw new TypeError("Missing settlement");
  expect(settle.operation.result.costUsd).toBeUndefined();
  actor.parent.stop();
});

it.each(kinds)("holds a %s result arriving before cancel ACK without gates, repairs or accounting", async kind => {
  const { actor, physical, entered, spawnAgent, runGate } = parked(kind);
  if (kind === "gate") actor.ack(await actor.next("NODE.REQUEST"));
  const signal = await entered.promise;
  const offset = actor.events.length;
  actor.send({ type: "CANCEL", disposition: "lifecycle" });
  const cancel = await actor.next("NODE.REQUEST", offset);
  physical.resolve({ ok: kind !== "gate", costUsd: 99 });
  await setImmediate();
  expect(signal.aborted).toBe(false);
  expect(actor.events).toHaveLength(offset + 1);
  expect(actor.child.getSnapshot().context.active).toBe(false);
  actor.ack(cancel);
  const settle = await actor.next("NODE.REQUEST", offset + 1);
  expect(settle.operation).toMatchObject({ kind: "settle", cancelled: true, projection: "retain" });
  expect(spawnAgent).toHaveBeenCalledTimes(kind === "human" ? 0 : 1);
  expect(runGate).toHaveBeenCalledTimes(kind === "gate" ? 1 : 0);
  actor.parent.stop();
});

it.each(kinds)("preserves first infrastructure error and waits for failed %s physical drain", async kind => {
  const { actor, input, physical, entered } = parked(kind);
  if (kind === "gate") actor.ack(await actor.next("NODE.REQUEST"));
  const signal = await entered.promise;
  const before = actor.events.length;
  const first = new TypeError("checkpoint failure");
  actor.send({ type: "FAIL", error: first });
  actor.send({ type: "FAIL", error: new TypeError("later") });
  actor.send({ type: "CANCEL", disposition: "skip" });
  expect(signal.reason).toBe(first);
  await setImmediate(); expect(actor.events).toHaveLength(before);
  physical.resolve({ ok: true, costUsd: 99 });
  const drain = await actor.next("NODE.DRAINED");
  expect(drain.failure.error).toBe(first);
  expect(drain.correlation).toEqual(input.receipt.correlation);
  expect(actor.events.slice(before)).toEqual([drain]);
  actor.parent.stop();
});

it.each(["gate", "repair"] as const)("latches cancellation during pending %s and ACKs it before any successor effect", async boundary => {
  const spawnAgent = vi.fn(async () => ({ ok: boundary === "gate", costUsd: 0.1 }));
  const runGate = vi.fn(async () => ({ ok: true, output: "" }));
  const input = agentInput({ host: { spawnAgent, runGate }, node: { ...agentInput().node, gate: "check", maxAttempts: 2 } });
  const actor = machine(input); actor.admit();
  const request = await actor.next("NODE.REQUEST");
  actor.send({ type: "CANCEL", disposition: "skip" });
  expect(actor.events).toHaveLength(1);
  const latest = boundary === "repair" ? repaired(input.receipt) : input.receipt;
  actor.ack(request, latest);
  const cancel = await actor.next("NODE.REQUEST", 1);
  expect(cancel).toMatchObject({ correlation: latest.correlation, operation: { kind: "cancel", disposition: "skip" } });
  actor.ack(cancel, latest);
  expect((await actor.next("NODE.REQUEST", 2)).operation).toMatchObject({ kind: "settle", cancelled: true });
  expect(spawnAgent).toHaveBeenCalledTimes(1); expect(runGate).not.toHaveBeenCalled(); actor.parent.stop();
});

it.each(["gate", "repair", "cancel", "settle"] as const)("reports exact %s checkpoint failure without further durable requests", async boundary => {
  const physical = deferred<NodeSpawnResult>();
  const entered = deferred<void>();
  const input = agentInput({ host: { spawnAgent: async () => { entered.resolve(); return boundary === "cancel" ? physical.promise : { ok: boundary !== "repair" }; } },
    node: { ...agentInput().node, ...(boundary === "gate" ? { gate: "check" } : {}), maxAttempts: boundary === "repair" ? 2 : 1 } });
  const actor = machine(input); actor.admit(); await entered.promise;
  if (boundary === "cancel") actor.send({ type: "CANCEL", disposition: "cancel" });
  const request = await actor.next("NODE.REQUEST");
  expect(request.operation.kind).toBe(boundary);
  const failure = { checkpoint: boundary };
  actor.send({ type: "FAIL", error: failure });
  // A root may already have an uncommitted repair identity. The child still drains its prior receipt.
  actor.ack(request, boundary === "repair" ? repaired(input.receipt) : input.receipt);
  physical.resolve({ ok: true });
  const drain = await actor.next("NODE.DRAINED");
  expect(drain.failure.error).toBe(failure);
  expect(drain.correlation).toEqual(input.receipt.correlation);
  expect(actor.events).toEqual([request, drain]); actor.parent.stop();
});

it("publishes fully correlated resolution and suppresses callbacks after abort or settlement", async () => {
  const physical = deferred<NodeSpawnResult>();
  const started = deferred<NodeSpawnRequest>();
  const input = agentInput({ host: { spawnAgent: (request) => { started.resolve(request); return physical.promise; } } });
  const actor = machine(input); actor.admit();
  const request = await started.promise;
  request.onResolved?.({ modelId: "effective" });
  expect(await actor.next("NODE.RESOLVED")).toMatchObject({ id: input.receipt.id, incarnation: input.receipt.incarnation, correlation: input.receipt.correlation, info: { modelId: "effective" } });
  actor.send({ type: "CANCEL", disposition: "cancel" });
  request.onResolved?.({ modelId: "during-cancel" });
  actor.ack(await actor.next("NODE.REQUEST"));
  request.onResolved?.({ modelId: "after-abort" });
  physical.resolve({ ok: true }); await actor.next("NODE.REQUEST", 2);
  request.onResolved?.({ modelId: "after-settlement" });
  expect(actor.events.filter(event => event.type === "NODE.RESOLVED")).toHaveLength(1); actor.parent.stop();
});

it("retains cancellation before admission without dispatching a host effect", async () => {
  const spawnAgent = vi.fn(async () => ({ ok: true }));
  const actor = machine(agentInput({ host: { spawnAgent } }));
  actor.send({ type: "CANCEL", disposition: "cancel" });
  expect(actor.events).toEqual([]);
  actor.admit(); actor.ack(await actor.next("NODE.REQUEST"));
  expect((await actor.next("NODE.REQUEST", 1)).operation).toMatchObject({ kind: "settle", executed: false, cancelled: true });
  expect(spawnAgent).not.toHaveBeenCalled(); actor.parent.stop();
});

it.each(kinds)("aborts the %s host signal on explicit actor stop", async kind => {
  const { actor, physical, entered } = parked(kind);
  if (kind === "gate") actor.ack(await actor.next("NODE.REQUEST"));
  const signal = await entered.promise;
  actor.parent.stop();
  expect(signal.aborted).toBe(true);
  physical.resolve({ ok: true });
  await setImmediate();
});

it.each(["agent", "human"] as const)("drains a rejecting noncooperative %s after cancellation ACK", async kind => {
  const physical = deferred<void>();
  const entered = deferred<void>();
  const effect = async () => { entered.resolve(); await physical.promise; throw new TypeError("late rejection"); };
  const input = kind === "agent" ? agentInput({ host: { spawnAgent: effect } }) : humanInput({ host: { spawnAgent: effect, awaitHumanGate: effect } });
  const actor = machine(input); actor.admit(); await entered.promise;
  actor.send({ type: "CANCEL", disposition: "cancel" });
  actor.ack(await actor.next("NODE.REQUEST"));
  physical.resolve();
  const settle = await actor.next("NODE.REQUEST", 1);
  expect(settle.operation).toMatchObject({ kind: "settle", cancelled: true, result: { ok: false, skipped: true, error: "Aborted." } });
  expect(actor.events.map(event => event.type)).toEqual(["NODE.REQUEST", "NODE.REQUEST"]); actor.parent.stop();
});
