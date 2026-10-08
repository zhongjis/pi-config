import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as persistence from "../src/graph/graph-persist.js";
import { deferred } from "./graph-drain.fixture.js";
import { boot, mockRunAgent, session } from "./graph-run-registration.fixture.js";
import { approve, gateGraph, gateNode, launch, pendingGate, reject, resolveGate, retrieve } from "./gate-tools.fixture.js";

it("cancels one parked retrieval without affecting another waiter or a later escalation", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const work = deferred<void>();
  mockRunAgent(async () => { await work.promise; return { responseText: "done", session, aborted: false, steered: false }; });
  const id = await launch(host, { ...gateGraph, nodes: { before: { type: "agent", agent: "fixture", prompt: "work" }, gate: gateNode }, edges: [{ from: "before", to: "gate" }] });
  const controller = new AbortController();
  const cancelled = retrieve(host, id, true, controller.signal);
  const survivor = pendingGate(host, id);
  controller.abort(new Error("cancel only waiter"));
  try { await expect(cancelled).rejects.toThrow("cancel only waiter"); }
  finally { work.resolve(); }
  const gate = await survivor;
  expect(await pendingGate(host, id)).toEqual(gate);
  await resolveGate(host, gate);
  expect((await retrieve(host, id)).details).toMatchObject({ status: "completed" });
});

it("keeps sibling nested escalations distinct and rejects pre-reload nested responses", async () => {
  const first = boot();
  mkdirSync(join(first.ctx.cwd, ".pi", "agent-graphs"), { recursive: true });
  writeFileSync(join(first.ctx.cwd, ".pi", "agent-graphs", "child.graph.json"), JSON.stringify(gateGraph));
  await first.lifecycle("session_start");
  const id = await launch(first, { nodes: { left: { type: "graph", graph: "child" }, right: { type: "graph", graph: "child" } }, edges: [], outputs: { left: { node: "left", path: "$" }, right: { node: "right", path: "$" } } });
  const old = await pendingGate(first, id);
  await first.lifecycle("session_shutdown");
  const second = boot();
  await second.lifecycle("session_start");
  const left = await pendingGate(second, id);
  await expect(resolveGate(second, old)).rejects.toThrow(/stale/i);
  await resolveGate(second, left, approve);
  const right = await pendingGate(second, id);
  expect(right.gate_id).not.toBe(left.gate_id);
  await resolveGate(second, right, reject);
  const result = await retrieve(second, id);
  expect(result.details).toMatchObject({ status: "completed" });
  const text = result.content.map(part => part.text).join("\n");
  expect(text).toContain('"decidedBy": "orchestrator"');
  expect(text).toContain('"decidedBy": "human"');
  expect(second.ui.select).not.toHaveBeenCalled();
});

it("never publishes an escalation when its durable dispatch checkpoint fails", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const write = persistence.writeGraphSnapshot;
  vi.spyOn(persistence, "writeGraphSnapshot").mockImplementation((cwd, snapshot) => {
    if (snapshot.state.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "dispatched" && row.payload.target === "escalation")) throw new Error("checkpoint failed");
    write(cwd, snapshot);
  });
  const id = await launch(host);
  expect((await retrieve(host, id)).details).toMatchObject({ status: "failed", gate: undefined, error: "checkpoint failed" });
  expect(host.ui.select).not.toHaveBeenCalled();
});
