import { expect, it } from "vitest";
import { boot, mockRunAgent, session } from "./graph-run-registration.fixture.js";
import { gateNode, launch, pendingGate, resolveGate, retrieve } from "./gate-tools.fixture.js";

it("externalizes hybrid uncertainty only after the internal agent supplies a typed reason", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  let decisions = 0;
  mockRunAgent(async () => {
    decisions++;
    return { responseText: JSON.stringify({ status: "undecided", reason: "Need owner consent" }), session, aborted: false, steered: false };
  });
  const id = await launch(host, { nodes: { gate: { ...gateNode, type: "hybrid_gate", agent: "fixture" } }, edges: [], outputs: { decision: { node: "gate", path: "$" } } });
  const gate = await pendingGate(host, id);
  expect((await retrieve(host, id)).details).toMatchObject({ gate: { kind: "hybrid_gate", prompt: expect.stringContaining("Need owner consent") } });
  expect(decisions).toBe(1);
  await resolveGate(host, gate);
  expect((await retrieve(host, id)).details).toMatchObject({ status: "completed", output: { decision: { approved: true } } });
  expect(host.ui.select).not.toHaveBeenCalled();
});

it.each(["agent_gate", "hybrid_gate"])("keeps a decided %s internal", async type => {
  const host = boot();
  await host.lifecycle("session_start");
  mockRunAgent(async () => ({ responseText: '{"status":"decided","decision":{"approved":false}}', session, aborted: false, steered: false }));
  const id = await launch(host, { nodes: { gate: { ...gateNode, type, agent: "fixture" } }, edges: [], outputs: { decision: { node: "gate", path: "$" } } });
  expect((await retrieve(host, id)).details).toMatchObject({ status: "completed", gate: undefined, output: { decision: { approved: false } } });
  expect(host.ui.select).not.toHaveBeenCalled();
});

it.each(["malformed", "empty-reason", "error", "agent-undecided"])("fails closed without human fallback: %s", async kind => {
  const host = boot();
  await host.lifecycle("session_start");
  mockRunAgent(async () => {
    if (kind === "error") throw new Error("executor failed");
    return { responseText: kind === "malformed" ? '{"approved":true}' : JSON.stringify({ status: "undecided", reason: kind === "empty-reason" ? " " : "Need human" }), session, aborted: false, steered: false };
  });
  const id = await launch(host, { nodes: { gate: { ...gateNode, type: kind === "agent-undecided" ? "agent_gate" : "hybrid_gate", agent: "fixture" } }, edges: [] });
  const result = await retrieve(host, id);
  expect(result.details).toMatchObject({ status: "failed", gate: undefined });
  expect(result.content.map(part => part.text).join("\n")).not.toContain("Human input required");
  expect(host.ui.select).not.toHaveBeenCalled();
});

it("resumes a durable hybrid handoff without repeating its agent decision", async () => {
  const first = boot();
  await first.lifecycle("session_start");
  let decisions = 0;
  mockRunAgent(async () => {
    decisions++;
    return { responseText: '{"status":"undecided","reason":"Need consent"}', session, aborted: false, steered: false };
  });
  const id = await launch(first, { nodes: { gate: { ...gateNode, type: "hybrid_gate", agent: "fixture" } }, edges: [], outputs: { decision: { node: "gate", path: "$" } } });
  const old = await pendingGate(first, id);
  await first.lifecycle("session_shutdown");
  const second = boot();
  await second.lifecycle("session_start");
  const gate = await pendingGate(second, id);
  expect(decisions).toBe(1);
  expect((await retrieve(second, id)).details).toMatchObject({ gate: { kind: "hybrid_gate", prompt: expect.stringContaining("Need consent") } });
  await expect(resolveGate(second, old)).rejects.toThrow(/stale/i);
  await resolveGate(second, gate);
  expect((await retrieve(second, id)).details).toMatchObject({ status: "completed" });
  expect(decisions).toBe(1);
});
