import { expect, it, vi } from "vitest";
import { boot } from "./graph-run-registration.fixture.js";
import { gateNode, launch, pendingGate, resolveGate, retrieve } from "./gate-tools.fixture.js";

it("resolves matching human input through the registered tool and completes the graph", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  const gate = await pendingGate(host, id);
  expect(host.tools.has("resolve_agent_graph_gate")).toBe(true);
  await resolveGate(host, gate);
  expect((await retrieve(host, id)).details).toMatchObject({ kind: "graph", status: "completed", output: { decision: { approved: true } } });
  expect(host.ui.select).not.toHaveBeenCalled();
});

it("accepts identical duplicate responses but rejects stale, conflicting and invalid responses", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  const gate = await pendingGate(host, id);
  await expect(resolveGate(host, { ...gate, revision: "stale" })).rejects.toThrow(/stale/i);
  await expect(resolveGate(host, { ...gate, gate_id: "wrong" })).rejects.toThrow(/stale/i);
  await expect(resolveGate(host, gate, { approved: "yes" })).rejects.toThrow(/invalid/i);
  await expect(resolveGate(host, gate, { approved: true, extra: true })).rejects.toThrow(/invalid/i);
  expect(await pendingGate(host, id)).toEqual(gate);
  const first = await resolveGate(host, gate);
  const duplicate = await resolveGate(host, gate);
  expect(duplicate).toEqual(first);
  await retrieve(host, id);
  expect(await resolveGate(host, gate)).toEqual(first);
  await expect(resolveGate(host, gate, { approved: false })).rejects.toThrow(/conflict/i);
  await expect(resolveGate(host, { ...gate, revision: "stale" })).rejects.toThrow(/stale/i);
});

it("aborts only retrieval while leaving the pending gate alive", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  const gate = await pendingGate(host, id);
  const controller = new AbortController();
  controller.abort(new Error("cancel retrieval"));
  await expect(retrieve(host, id, true, controller.signal)).rejects.toThrow("cancel retrieval");
  expect(await pendingGate(host, id)).toEqual(gate);
  await resolveGate(host, gate, { approved: false });
  expect((await retrieve(host, id)).details).toMatchObject({ status: "completed", output: { decision: { approved: false } } });
});

it("notifies a human gate when no waiter exists and does not duplicate a retrieved gate", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  await vi.waitFor(() => expect(host.api.sendMessage.mock.calls.some(([message]) => message.content.includes("Human input required"))).toBe(true));
  const gate = await pendingGate(host, id);
  await pendingGate(host, id);
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(host.api.sendMessage.mock.calls.filter(([message]) => message.content.includes("Human input required"))).toHaveLength(1);
  await resolveGate(host, gate);
  await retrieve(host, id);
  host.api.sendMessage.mockClear();
  const watched = await launch(host);
  const observed = await pendingGate(host, watched);
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(host.api.sendMessage.mock.calls.some(([message]) => message.content.includes("Human input required"))).toBe(false);
  await resolveGate(host, observed);
});

it("enforces the gate's authored response schema without consuming rejected input", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host, { nodes: { gate: { ...gateNode, outputSchema: { ...gateNode.outputSchema, properties: { approved: { const: false } } } } }, edges: [], outputs: { decision: { node: "gate", path: "$" } } });
  const gate = await pendingGate(host, id);
  await expect(resolveGate(host, gate, { approved: true })).rejects.toThrow(/invalid/i);
  expect(await pendingGate(host, id)).toEqual(gate);
  await resolveGate(host, gate, { approved: false });
  expect((await retrieve(host, id)).details).toMatchObject({ status: "completed", output: { decision: { approved: false } } });
});
