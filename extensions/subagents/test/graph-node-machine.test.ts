import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { NodeHost, NodeSpawnRequest } from "../src/graph/node-host.js";
import { agentInput, decisionInput, escalationInput, escalationResponse, machine, repaired, schema, terminal } from "./graph-node-machine.fixture.js";

it.each(["agent", "escalation"] as const)("waits for committed admission before the %s effect", async kind => {
  const effect = vi.fn(async () => ({ ok: true, output: escalationResponse }));
  const input = kind === "agent" ? agentInput({ host: { spawnAgent: effect } }) : escalationInput({ host: { spawnAgent: effect, awaitEscalation: effect } });
  const actor = machine(input);
  await setImmediate();
  expect(effect).not.toHaveBeenCalled();
  actor.admit();
  expect((await actor.next("NODE.REQUEST")).operation.kind).toBe("settle");
  expect(effect).toHaveBeenCalledTimes(1);
  actor.parent.stop();
});

it.each(["agent", "escalation"] as const)("rejects mismatched %s admission without a host effect", async kind => {
  const effect = vi.fn(async () => ({ ok: true, output: escalationResponse }));
  const input = kind === "agent" ? agentInput({ host: { spawnAgent: effect } }) : escalationInput({ host: { spawnAgent: effect, awaitEscalation: effect } });
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
it.each(outputs)("preserves agent $name output", async ({ result, structured, expected }) => {
  const input = agentInput({ host: { spawnAgent: async () => result } });
  const run = await terminal({ ...input, node: { ...input.node, ...(structured ? { schema: schema() } : {}) } });
  expect(run.result).toMatchObject(expected);
});

const escalations = [
  { name: "valid response", result: { ok: true, output: escalationResponse }, expected: { ok: true, output: JSON.stringify({ decidedBy: "orchestrator", answers: { q: { value: true, confidence: 1 } } }) } },
  { name: "invalid JSON", result: { ok: true, output: "invalid" }, expected: { ok: false } },
  { name: "wrong answer", result: { ok: true, output: JSON.stringify({ answers: { q: "yes" }, decidedBy: "orchestrator" }) }, expected: { ok: false, error: expect.stringContaining("Invalid escalation answer") } },
  { name: "host failure", result: { ok: false, error: "host failed" }, expected: { ok: false, error: "host failed" } },
  { name: "dismissal", result: { ok: false, skipped: true }, expected: { ok: false, skipped: true } },
];
it.each(escalations)("maps escalation $name", async ({ result, expected }) => {
  const run = await terminal(escalationInput({ host: { spawnAgent: async () => ({ ok: true }), awaitEscalation: async () => result } }));
  expect(run.result).toMatchObject(expected);
});

it("requests an escalation after an undecided model chain and awaits it only after ACK", async () => {
  const awaitEscalation = vi.fn(async () => ({ ok: true, output: escalationResponse }));
  const input = decisionInput({ host: { spawnAgent: async () => ({ ok: true }), decide: async () => ({ ok: false, error: "no model" }), awaitEscalation } });
  const actor = machine(input); actor.admit();
  const request = await actor.next("NODE.REQUEST");
  expect(request.operation).toMatchObject({ kind: "escalate", reason: expect.any(String) });
  expect(awaitEscalation).not.toHaveBeenCalled();
  actor.ack(request);
  expect((await actor.next("NODE.REQUEST", 1)).operation).toMatchObject({ kind: "settle", result: { ok: true } });
  expect(awaitEscalation).toHaveBeenCalledTimes(1);
  actor.parent.stop();
});

it.each(["agent", "escalation", "gate"] as const)("converts a rejected %s host effect into a node failure", async kind => {
  const rejection = async () => { throw new TypeError("host rejection"); };
  const input = kind === "escalation" ? escalationInput({ host: { spawnAgent: rejection, awaitEscalation: rejection } }) : agentInput({
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

it("fails a missing escalation capability without spawning an agent", async () => {
  const spawnAgent = vi.fn(async () => ({ ok: true }));
  expect((await terminal(escalationInput({ host: { spawnAgent } }))).result).toMatchObject({ ok: false, error: "This host cannot escalate decisions" });
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

it("keeps attempt 1 identical and appends the schema failure to the repaired prompt", async () => {
  const prompts: string[] = [];
  const input = agentInput({ host: { spawnAgent: async request => { prompts.push(request.prompt); return { ok: true, output: prompts.length === 1 ? '{"approved":"yes"}' : '{"approved":true}' }; } },
    node: { ...agentInput().node, schema: schema(), maxAttempts: 2 } });
  const actor = machine(input); actor.admit();
  const repair = await actor.next("NODE.REQUEST");
  expect(prompts).toEqual(["fixture"]);
  const error = repair.operation.kind === "repair" ? repair.operation.result.error : undefined;
  expect(error).toEqual(expect.stringContaining("did not match the requested schema"));
  actor.ack(repair, repaired(input.receipt));
  await actor.next("NODE.REQUEST", 1);
  expect(prompts[1]?.startsWith("fixture\n\n")).toBe(true);
  expect(prompts[1]).toContain(error ?? "");
  actor.parent.stop();
});

it("includes the failing gate stderr tail in the repaired prompt", async () => {
  const stderr = "fatal: validation gate rejected the diff";
  const output = `${"stdout ".repeat(500)}${stderr}`;
  const prompts: string[] = [];
  let gates = 0;
  const input = agentInput({ host: {
    spawnAgent: async request => { prompts.push(request.prompt); return { ok: true }; },
    runGate: async () => ({ ok: ++gates > 1, output: gates === 1 ? output : "" }),
  }, node: { ...agentInput().node, gate: "check", maxAttempts: 2 } });
  await terminal(input);
  expect(prompts[0]).toBe("fixture");
  expect(prompts[1]?.startsWith("fixture\n\n")).toBe(true);
  expect(prompts[1]).toContain(stderr);
  expect(prompts[1]).not.toContain(output);
});

it("bounds a very long repair error to its tail in every repaired prompt", async () => {
  const marker = "UNIQUE_TAIL";
  const error = `${"x".repeat(4000)}${marker}`;
  const prompts: string[] = [];
  const input = agentInput({ host: { spawnAgent: async request => { prompts.push(request.prompt); return { ok: false, error }; } },
    node: { ...agentInput().node, maxAttempts: 3 } });
  await terminal(input);
  const tail = error.slice(-2000);
  expect(prompts[0]).toBe("fixture");
  for (const prompt of prompts.slice(1)) {
    expect(prompt.startsWith("fixture\n\n")).toBe(true);
    expect(prompt).toContain(tail);
    expect(prompt).not.toContain(error);
  }
  expect(prompts).toHaveLength(3);
  expect(tail).toHaveLength(2000);
  expect(tail.endsWith(marker)).toBe(true);
});

it("uses the original prompt when a restored attempt has no remembered failure", async () => {
  const prompts: string[] = [];
  const input = agentInput({ host: { spawnAgent: async request => { prompts.push(request.prompt); return { ok: true }; } },
    node: { ...agentInput().node, maxAttempts: 3 } });
  await terminal({ ...input, receipt: { ...input.receipt, executionSequence: 2 } });
  expect(prompts).toEqual(["fixture"]);
});
