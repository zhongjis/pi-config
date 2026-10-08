import { afterEach, expect, it, vi } from "vitest";
import { approve, gateNode, launch, pendingGate, reject, resolveGate, retrieve } from "./gate-tools.fixture.js";
import { boot } from "./graph-run-registration.fixture.js";

afterEach(() => {
  vi.useRealTimers();
});

it("resolves an escalation through the registered tool and completes the graph", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  await resolveGate(host, await pendingGate(host, id));
  expect((await retrieve(host, id)).details).toMatchObject({ kind: "graph", status: "completed", output: { decision: { answers: { release: { value: true, confidence: 1 } }, decidedBy: "orchestrator" } } });
});

it("accepts an identical duplicate response", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  const gate = await pendingGate(host, id);
  const first = await resolveGate(host, gate);
  expect(await resolveGate(host, gate)).toEqual(first);
});

it.each([
  ["stale revision", { revision: "stale" }, approve, /stale/i],
  ["unknown gate", { gate_id: "wrong" }, approve, /stale/i],
  ["wrong answer type", {}, { answers: { release: "yes" }, decidedBy: "human" }, /invalid/i],
  ["missing answer", {}, { answers: {}, decidedBy: "human" }, /invalid/i],
  ["extra answer", {}, { answers: { release: true, other: true }, decidedBy: "human" }, /invalid/i],
  ["model provenance", {}, { answers: { release: true }, decidedBy: "classifier" }, /invalid/i],
])("rejects a %s without consuming the escalation", async (_label, identity, response, error) => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  const gate = await pendingGate(host, id);
  await expect(resolveGate(host, { ...gate, ...identity }, response)).rejects.toThrow(error);
  expect(await pendingGate(host, id)).toEqual(gate);
});

it("rejects a conflicting response after acceptance", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  const gate = await pendingGate(host, id);
  await resolveGate(host, gate);
  await retrieve(host, id);
  await expect(resolveGate(host, gate, reject)).rejects.toThrow(/conflict/i);
});

it("rejects a choice outside the question's labels", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const questions = { route: { type: "choice", instructions: "Which route?", criteria: { fast: "Fast path", safe: "Safe path" } } };
  const id = await launch(host, { nodes: { gate: { ...gateNode, questions } }, edges: [] });
  await expect(resolveGate(host, await pendingGate(host, id), { answers: { route: "slow" }, decidedBy: "human" })).rejects.toThrow(/invalid/i);
});

it("aborts only retrieval while leaving the escalation alive", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  const gate = await pendingGate(host, id);
  const controller = new AbortController();
  controller.abort(new Error("cancel retrieval"));
  await expect(retrieve(host, id, true, controller.signal)).rejects.toThrow("cancel retrieval");
  expect(await pendingGate(host, id)).toEqual(gate);
});

const nudges = (host: ReturnType<typeof boot>) => host.api.sendMessage.mock.calls.filter(([message]) => message.content.includes("Decision escalated"));

it("nudges an unobserved escalation exactly once", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  await vi.waitFor(() => expect(nudges(host).length).toBeGreaterThan(0));
  // Graph actor delays also run on timers: fake them only around the nudge window,
  // and restore real timers before the run resumes past its gate.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const gate = await pendingGate(host, id);
  await pendingGate(host, id);
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  try { expect(nudges(host)).toHaveLength(1); }
  finally { await resolveGate(host, gate); }
});

it("does not nudge an escalation already retrieved", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const id = await launch(host);
  const watching = pendingGate(host, id);
  await vi.runOnlyPendingTimersAsync();
  const observed = await watching;
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  try { expect(nudges(host)).toHaveLength(0); }
  finally { await resolveGate(host, observed); }
});
