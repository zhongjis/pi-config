import { expect, it, vi } from "vitest";
import { gateNode, type Host, launch, pendingGate, reject, resolveGate, retrieve } from "./gate-tools.fixture.js";
import { boot } from "./graph-run-registration.fixture.js";

async function reason(host: Host, id: string): Promise<unknown> {
  const details: unknown = (await retrieve(host, id)).details;
  return details && typeof details === "object" && "gate" in details && details.gate && typeof details.gate === "object" && "reason" in details.gate ? details.gate.reason : undefined;
}
const stateGraph = { nodes: { gate: { ...gateNode, state: { request: { path: "$.request" } } } }, edges: [], outputs: { decision: { node: "gate", path: "$" } } };

it("publishes the escalation's identity, reason, questions, resolved state and response schema", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host, stateGraph, { request: "ship v2" });
  await pendingGate(host, id);
  expect((await retrieve(host, id)).details).toMatchObject({ gate: {
    gate_id: expect.any(String), revision: expect.any(String), kind: "decision_gate", reason: expect.stringMatching(/\S/),
    questions: gateNode.questions, state: { request: "ship v2" }, response_schema: expect.objectContaining({ type: "object" }),
  } });
});

it("tells the orchestrator how to resolve the escalation", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  const gate = await pendingGate(host, id);
  const text = (await retrieve(host, id)).content.map(part => part.text).join("\n");
  for (const part of ["resolve_agent_graph_gate", gate.gate_id, gate.revision, "response_schema"]) expect(text).toContain(part);
});

it("bounds escalation state in text while details keep the full state", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const request = "x".repeat(20_000);
  const id = await launch(host, stateGraph, { request });
  await pendingGate(host, id);
  const result = await retrieve(host, id);
  expect([result.content.map(part => part.text).join("\n").includes(request), result.details]).toEqual([false, expect.objectContaining({ gate: expect.objectContaining({ state: { request } }) })]);
});

it("completes with the responder's decision", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  await resolveGate(host, await pendingGate(host, id), reject);
  expect((await retrieve(host, id)).details).toMatchObject({ status: "completed", output: { decision: { answers: { release: { value: false, confidence: 1 } }, decidedBy: "human" } } });
});

it("never prompts the user interface itself", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const id = await launch(host);
  await resolveGate(host, await pendingGate(host, id));
  await retrieve(host, id);
  expect(host.ui.select).not.toHaveBeenCalled();
});

it("resumes a durable escalation without repeating its decision", async () => {
  const first = boot();
  await first.lifecycle("session_start");
  const id = await launch(first);
  await pendingGate(first, id);
  await first.lifecycle("session_shutdown");
  const { runAgent } = await import("../src/agent-runner.js");
  const decisions = vi.mocked(runAgent).mock.calls.length;
  const second = boot();
  await second.lifecycle("session_start");
  await resolveGate(second, await pendingGate(second, id));
  await retrieve(second, id);
  expect(vi.mocked(runAgent).mock.calls.length).toBe(decisions);
});

it("re-publishes a resumed escalation with its original reason", async () => {
  const first = boot();
  await first.lifecycle("session_start");
  const id = await launch(first);
  await pendingGate(first, id);
  const before = await reason(first, id);
  await first.lifecycle("session_shutdown");
  const second = boot();
  await second.lifecycle("session_start");
  await pendingGate(second, id);
  expect(await reason(second, id)).toBe(before);
});
