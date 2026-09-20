import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as persistence from "../src/graph/graph-persist.js";
import * as hostModule from "../src/graph/node-host-adapter.js";
import * as tasks from "../src/graph/task.js";
import { boot, required } from "./workflow-registration.fixture.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { executionFails: false, disposalFails: false, status: "completed", error: undefined },
  { executionFails: true, disposalFails: false, status: "failed", error: "checkpoint failure" },
  { executionFails: false, disposalFails: true, status: "failed", error: "disposal failure" },
  { executionFails: true, disposalFails: true, status: "failed", error: "checkpoint failure" },
] as const)("finalizes after disposal and preserves execution failure precedence: $executionFails/$disposalFails", async scenario => {
  const session = boot({ workflowsEnabled: true });
  await session.lifecycle("session_start");
  let settleDisposal: () => void = () => { throw new Error("missing disposal"); };
  const disposal = new Promise<void>((resolve, reject) => {
    settleDisposal = () => { if (scenario.disposalFails) reject(new Error("disposal failure")); else resolve(); };
  });
  const dispose = vi.fn(() => disposal);
  const original = hostModule.createNodeHost;
  vi.spyOn(hostModule, "createNodeHost").mockImplementation(options => ({ ...original(options), dispose }));
  if (scenario.executionFails) vi.spyOn(persistence, "writeGraphSnapshot").mockImplementation(() => { throw new Error("checkpoint failure"); });
  const create = vi.spyOn(tasks, "createWorkflowTask");
  const remove = vi.spyOn(persistence, "deleteGraphSnapshot");
  const graph = { nodes: { a: { type: "agent", agent: "fixture", prompt: "work" } }, edges: [] };
  const result = await required(session.tools.get("agent_graph")).execute("call", { graph }, undefined, undefined, session.ctx);
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  const task = required(create.mock.results[0]?.value);
  const before = { status: task.status, endTime: task.endTime, deletes: remove.mock.calls.length, notifications: session.api.sendMessage.mock.calls.length };
  let stopped = false;
  const stop = session.lifecycle("session_shutdown").then(() => { stopped = true; });
  await setImmediate();
  const stoppedBeforeDrain = stopped;
  settleDisposal();
  await stop;
  expect(before).toEqual({ status: "running", endTime: undefined, deletes: 0, notifications: 0 });
  expect(stoppedBeforeDrain).toBe(false);
  expect(task).toMatchObject({ status: scenario.status, ...(scenario.error === undefined ? {} : { error: scenario.error }) });
  expect(result.details?.taskId).toBe(task.id);
});
