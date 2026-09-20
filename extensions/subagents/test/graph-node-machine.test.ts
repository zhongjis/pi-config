import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { NodeHost, NodeSpawnRequest } from "../src/graph/node-host.js";
import { agentInput, humanInput, machine, repaired, schema, terminal } from "./graph-node-machine.fixture.js";

it.each(["agent", "human"] as const)("waits for committed admission before the %s effect", async kind => {
  const effect = vi.fn(async () => ({ ok: true }));
  const input = kind === "agent" ? agentInput({ host: { spawnAgent: effect } }) : humanInput({ host: { spawnAgent: effect, awaitHumanGate: effect } });
  const actor = machine(input);
  await setImmediate();
  expect(effect).not.toHaveBeenCalled();
  actor.admit();
  expect((await actor.next("NODE.REQUEST")).operation.kind).toBe("settle");
  expect(effect).toHaveBeenCalledTimes(1);
  actor.parent.stop();
});

it.each(["agent", "human"] as const)("rejects mismatched %s admission without a host effect", async kind => {
  const effect = vi.fn(async () => ({ ok: true }));
  const input = kind === "agent" ? agentInput({ host: { spawnAgent: effect } }) : humanInput({ host: { spawnAgent: effect, awaitHumanGate: effect } });
  const actor = machine(input);
  actor.send({ type: "NODE.ADMITTED", receipt: { ...input.receipt, incarnation: "stale" } });
  expect((await actor.next("NODE.DRAINED")).failure.error).toBeInstanceOf(TypeError);
  expect(effect).not.toHaveBeenCalled();
  actor.parent.stop();
});

const outputs = [
  { name: "plain", result: { ok: true, output: "hello" }, structured: false, expected: { ok: true, output: "hello" } },
  { name: "structured", result: { ok: true, output: '{"approved":true}' }, structured: true, expected: { ok: true, output: '{"approved":true}' } },
  { name: "schema mismatch", result: { ok: true, output: '{"approved":"yes"}' }, structured: true, expected: { ok: false, error: expect.stringContaining("did not match the requested schema") } },
  { name: "invalid JSON", result: { ok: true, output: "invalid" }, structured: true, expected: { ok: false, error: expect.stringContaining("was not JSON") } },
  { name: "host failure", result: { ok: false, error: "host failed" }, structured: true, expected: { ok: false, error: "host failed" } },
  { name: "dismissal", result: { ok: false, skipped: true }, structured: true, expected: { ok: false, skipped: true } },
];
it.each((["agent", "human"] as const).flatMap(kind => outputs.map(output => ({ kind, ...output }))))("preserves $kind $name output", async ({ kind, result, structured, expected }) => {
  const effect = async () => result;
  const input = kind === "agent" ? agentInput({ host: { spawnAgent: effect } }) : humanInput({ host: { spawnAgent: effect, awaitHumanGate: effect } });
  const run = await terminal({ ...input, node: { ...input.node, ...(structured ? { schema: schema() } : {}) } });
  expect(run.result).toMatchObject(expected);
});

it.each(["agent", "human", "gate"] as const)("converts a rejected %s host effect into a node failure", async kind => {
  const rejection = async () => { throw new TypeError("host rejection"); };
  const input = kind === "human" ? humanInput({ host: { spawnAgent: rejection, awaitHumanGate: rejection } }) : agentInput({
    host: { spawnAgent: kind === "agent" ? rejection : async () => ({ ok: true, costUsd: 0.4 }), runGate: rejection },
    node: { ...agentInput().node, ...(kind === "gate" ? { gate: "check" } : {}) },
  });
  expect((await terminal(input)).result).toMatchObject({ ok: false, error: "host rejection", ...(kind === "gate" ? { costUsd: 0.4 } : {}) });
});

it.each([true, false])("runs one gate after ACK with child cwd, correlation and cost (ok=%s)", async ok => {
  const runGate = vi.fn(async () => ({ ok, output: " gate failed " }));
  const input = agentInput({ host: { spawnAgent: async () => ({ ok: true, output: "done", cwd: "/child", costUsd: 0.3 }), runGate }, node: { ...agentInput().node, gate: "check" } });
  const actor = machine(input); actor.admit();
  const gate = await actor.next("NODE.REQUEST");
  expect(gate.operation).toEqual({ kind: "gate", costUsd: 0.3 });
  expect(runGate).not.toHaveBeenCalled();
  actor.ack(gate);
  const settle = await actor.next("NODE.REQUEST", 1);
  expect(runGate).toHaveBeenCalledExactlyOnceWith("check", { cwd: "/child", signal: expect.any(AbortSignal), correlation: input.receipt.correlation });
  expect(settle.operation).toMatchObject({ kind: "settle", result: { ok, cwd: "/child", costUsd: 0.3, ...(ok ? {} : { error: "gate failed" }) } });
  actor.parent.stop();
});

it.each(["absent", "revoked"] as const)("fails closed when gate capability is %s at dispatch", async capability => {
  const runGate = vi.fn(async () => ({ ok: true, output: "" }));
  const host: NodeHost = { spawnAgent: async () => ({ ok: true }), ...(capability === "revoked" ? { runGate } : {}) };
  const actor = machine(agentInput({ host, node: { ...agentInput().node, gate: "check" } })); actor.admit();
  const gate = await actor.next("NODE.REQUEST");
  delete host.runGate;
  actor.ack(gate);
  expect((await actor.next("NODE.REQUEST", 1)).operation).toMatchObject({ kind: "settle", result: { ok: false, error: expect.stringContaining("cannot run gate") } });
  expect(runGate).not.toHaveBeenCalled(); actor.parent.stop();
});

it("fails a missing human prompt capability without spawning an agent", async () => {
  const spawnAgent = vi.fn(async () => ({ ok: true }));
  expect((await terminal(humanInput({ host: { spawnAgent } }))).result).toMatchObject({ ok: false, error: "This host cannot await human input" });
  expect(spawnAgent).not.toHaveBeenCalled();
});

it("atomically switches repair identity before a second spawn and preserves each cost", async () => {
  const requests: NodeSpawnRequest[] = [];
  const input = agentInput({ host: { spawnAgent: async request => { requests.push(request); return { ok: true, output: requests.length === 1 ? "invalid" : '{"approved":true}', costUsd: requests.length / 10 }; } },
    node: { ...agentInput().node, schema: schema(), maxAttempts: 2 } });
  const actor = machine(input); actor.admit();
  const repair = await actor.next("NODE.REQUEST");
  expect(repair.operation).toMatchObject({ kind: "repair", result: { ok: false, costUsd: 0.1 }, executed: true });
  expect(requests).toHaveLength(1);
  const next = repaired(input.receipt); actor.ack(repair, next);
  const settle = await actor.next("NODE.REQUEST", 1);
  expect(requests.map(request => [request.attempt, request.correlation])).toEqual([[1, input.receipt.correlation], [2, next.correlation]]);
  expect(settle).toMatchObject({ correlation: next.correlation, requestSequence: 2, operation: { kind: "settle", result: { ok: true, costUsd: 0.2 } } });
  actor.parent.stop();
});

it.each(["exhausted", "restored", "skipped"] as const)("does not replenish a %s execution budget", async condition => {
  const spawnAgent = vi.fn(async () => ({ ok: false, skipped: condition === "skipped", error: "failed" }));
  const input = agentInput({ host: { spawnAgent }, node: { ...agentInput().node, maxAttempts: 2 } });
  const result = await terminal({ ...input, receipt: { ...input.receipt, executionSequence: condition === "restored" ? 2 : 1 } });
  expect(result.result.ok).toBe(false);
  expect(spawnAgent).toHaveBeenCalledTimes(condition === "exhausted" ? 2 : 1);
});

it.each(["initial", "repair"] as const)("rechecks authorization immediately before the %s spawn", async boundary => {
  let denied: string | undefined = boundary === "initial" ? "denied" : undefined;
  const spawnAgent = vi.fn(async () => ({ ok: false }));
  const input = agentInput({ authorize: () => denied, host: { spawnAgent }, node: { ...agentInput().node, maxAttempts: boundary === "initial" ? 1 : 2 } });
  const actor = machine(input); actor.admit();
  const first = await actor.next("NODE.REQUEST");
  if (boundary === "repair") { denied = "denied"; actor.ack(first, repaired(input.receipt)); }
  const settle = boundary === "initial" ? first : await actor.next("NODE.REQUEST", 1);
  expect(settle.operation).toMatchObject({ kind: "settle", executed: false, result: { ok: false, error: "denied" } });
  expect(spawnAgent).toHaveBeenCalledTimes(boundary === "initial" ? 0 : 1); actor.parent.stop();
});

it("repairs a failed gate with a new spawn before running the next gate", async () => {
  const order: string[] = [];
  let gates = 0;
  const input = agentInput({ host: {
    spawnAgent: async () => { order.push("spawn"); return { ok: true, costUsd: 0.2 }; },
    runGate: async () => { order.push("gate"); return { ok: ++gates === 2, output: "failed" }; },
  }, node: { ...agentInput().node, gate: "check", maxAttempts: 2 } });
  const run = await terminal(input);
  expect(run.result).toMatchObject({ ok: true, costUsd: 0.2 });
  expect(order).toEqual(["spawn", "gate", "spawn", "gate"]);
  expect(run.events.filter(event => event.type === "NODE.REQUEST").map(event => event.operation.kind)).toEqual(["gate", "repair", "gate", "settle"]);
});
