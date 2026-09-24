import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LiveWriterError } from "../src/graph/graph-checkpoint-owner.js";
import * as persistence from "../src/graph/graph-persist.js";
import { readGraphSnapshots } from "../src/graph/graph-persist.js";
import * as tasks from "../src/graph/task.js";
import { deferred, releaseAfterPending } from "./graph-drain.fixture.js";
import { boot, required } from "./graph-run-registration.fixture.js";

const gateGraph = {
  name: "gated",
  nodes: {
    a: { type: "agent", agent: "fixture", prompt: "step a" },
    gate: {
      type: "human_gate",
      prompt: "approve?",
      outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    },
    done: { type: "agent", agent: "fixture", prompt: "finish" },
  },
  edges: [
    { from: "a", to: "gate" },
    { from: "gate", to: "done", when: { eq: [{ node: "gate", path: "$.approved" }, true] } },
  ],
};

describe("agent_graph durable human_gate resume", () => {
  it("resumes a drained human gate under a new graph attempt on restart", async () => {
    // Session 1 parks at the gate until shutdown requests cancellation.
    const s1 = boot({ agentGraphEnabled: true });
    await s1.lifecycle("session_start");
    const human = deferred<string>();
    s1.ui.select.mockReturnValue(human.promise);
    const result = await required(s1.tools.get("agent_graph")).execute(
      "call",
      { graph: gateGraph, input: {} },
      undefined,
      undefined,
      s1.ctx,
    );
    const runId = required(result.details?.taskId);

    // The run reaches the gate and writes a durable snapshot.
    await vi.waitFor(() => {
      expect(s1.ui.select.mock.calls.length, JSON.stringify(s1.api.sendMessage.mock.calls)).toBeGreaterThan(0);
      expect(readGraphSnapshots(s1.ctx.cwd).some(s => s.runId === runId)).toBe(true);
    });

    // A mutable session manager must not relabel an already-running checkpoint.
    vi.spyOn(s1.ctx.sessionManager, "getSessionId").mockReturnValue("switched");
    // Simulate shutdown: the parked run aborts, but its snapshot is kept.
    const shutdown = s1.lifecycle("session_shutdown");
    await releaseAfterPending(shutdown, () => human.resolve("Approve"));
    await shutdown;
    expect(required(readGraphSnapshots(s1.ctx.cwd).find(s => s.runId === runId))).toMatchObject({ ownerSessionId: "parent" });

    // Restart can reclaim a dead writer, but only for this same Pi session.
    const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
    expect(dead.status).toBe(0);
    writeFileSync(join(persistence.graphRunsDir(s1.ctx.cwd), `${runId}.json.run.lock`), JSON.stringify(dead.pid));
    // Restart admits a new graph attempt, without repairing the cancelled execution.
    const s2 = boot({ agentGraphEnabled: true });
    s2.ui.select.mockResolvedValue("Approve");
    await s2.lifecycle("session_start"); // resumeDurableGraphRuns re-launches the run

    const message = await s2.notification(runId);
    expect(message.content).toContain("Execution: completed");
    expect(s2.ui.select).toHaveBeenCalledTimes(1);
    // A settled run clears its snapshot.
    expect(readGraphSnapshots(s2.ctx.cwd).some(s => s.runId === runId)).toBe(false);
  });
});

it("persists effective fanout topology through the graph runtime and resumes it once", async () => {
  const s1 = boot({ agentGraphEnabled: true });
  await s1.lifecycle("session_start");
  const human = deferred<string>();
  s1.ui.select.mockReturnValue(human.promise);
  const graph = {
    nodes: {
      research: {
        type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object" },
        dispatch: { path: "$.source", cases: { project: "fixture" } }, prompt: `\${item}`,
      },
      gate: gateGraph.nodes.gate,
    },
    edges: [],
  };
  const result = await required(s1.tools.get("agent_graph")).execute(
    "call", { graph, input: { tasks: [{ source: "project" }] } }, undefined, undefined, s1.ctx,
  );
  const runId = required(result.details?.taskId);
  await vi.waitFor(() => expect(readGraphSnapshots(s1.ctx.cwd).some(s => s.runId === runId)).toBe(true));
  const saved = required(readGraphSnapshots(s1.ctx.cwd).find(s => s.runId === runId));
  expect(saved.graph.nodes["research:item:0"]).toMatchObject({ type: "agent", agent: "fixture" });
  expect(saved.state.collections?.research).toEqual([{ nodeId: "research:item:0", item: { source: "project" } }]);
  const shutdown = s1.lifecycle("session_shutdown");
  await releaseAfterPending(shutdown, () => human.resolve("Approve"));
  await shutdown;
  const s2 = boot({ agentGraphEnabled: true });
  s2.ui.select.mockResolvedValue("Approve");
  await s2.lifecycle("session_start");
  const message = await s2.notification(runId);
  expect(message.content).toContain("Execution: completed");
  expect(readGraphSnapshots(s2.ctx.cwd).some(s => s.runId === runId)).toBe(false);
});

it.each(["foreign live", "foreign dead", "ownerless v1", "ownerless v2", "same-session live", "corrupt"] as const)(
  "checks recovery ownership before side effects: %s", async kind => {
    const origin = boot({ agentGraphEnabled: true }, "origin");
    await origin.lifecycle("session_start");
    const human = deferred<string>();
    origin.ui.select.mockReturnValue(human.promise);
    const result = await required(origin.tools.get("agent_graph")).execute(
      "call", { graph: gateGraph, input: {} }, undefined, undefined, origin.ctx,
    );
    const runId = required(result.details?.taskId);
    await vi.waitFor(() => expect(origin.ui.select.mock.calls.length, JSON.stringify(origin.api.sendMessage.mock.calls)).toBe(1));
    const path = join(persistence.graphRunsDir(origin.ctx.cwd), `${runId}.json`);
    const lock = `${path}.run.lock`;
    const live = kind === "foreign live" || kind === "same-session live";
    {
      const shutdown = origin.lifecycle("session_shutdown");
      await releaseAfterPending(shutdown, () => human.resolve("Approve"));
      await shutdown;
      if (kind === "foreign dead") {
        const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
        expect(dead.status).toBe(0);
        writeFileSync(lock, JSON.stringify(dead.pid));
      }
      if (kind === "ownerless v1" || kind === "ownerless v2") {
        const saved = required(readGraphSnapshots(origin.ctx.cwd).find(s => s.runId === runId));
        delete saved.ownerSessionId;
        if (kind === "ownerless v1") saved.version = 1;
        writeFileSync(path, JSON.stringify(saved));
      }
      if (kind === "corrupt") writeFileSync(path, "{broken");
    }
    const release = live ? persistence.ownGraphRun(origin.ctx.cwd, runId) : undefined;
    const original = readFileSync(path, "utf8");
    const lockBefore = live || kind === "foreign dead" ? readFileSync(lock, "utf8") : undefined;
    const next = boot({ agentGraphEnabled: true }, kind === "same-session live" || kind === "corrupt" ? "origin" : "foreign");
    const create = vi.spyOn(tasks, "createGraphRunTask");
    const lease = vi.spyOn(persistence, "ownGraphRun");
    const write = vi.spyOn(persistence, "writeGraphSnapshot");
    const remove = vi.spyOn(persistence, "deleteGraphSnapshot");
    const { runAgent } = await import("../src/agent-runner.js");
    vi.mocked(runAgent).mockClear();
    try {
      await next.lifecycle("session_start");
      expect(create).not.toHaveBeenCalled();
      expect(lease).not.toHaveBeenCalled();
      expect(next.api.sendMessage).not.toHaveBeenCalled();
      if (kind === "corrupt") expect(next.ui.notify).toHaveBeenCalled();
      else expect(next.ui.notify).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
      expect(next.ui.select).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(readFileSync(path, "utf8")).toBe(original);
      if (lockBefore !== undefined) expect(readFileSync(lock, "utf8")).toBe(lockBefore);
    } finally {
      await next.lifecycle("session_shutdown");
      release?.();
    }
  },
);

it("declines a resume the peek loses but the lease refuses (TOCTOU race)", async () => {
  const origin = boot({ agentGraphEnabled: true }, "origin");
  await origin.lifecycle("session_start");
  const human = deferred<string>();
  origin.ui.select.mockReturnValue(human.promise);
  const result = await required(origin.tools.get("agent_graph")).execute(
    "call", { graph: gateGraph, input: {} }, undefined, undefined, origin.ctx,
  );
  const runId = required(result.details?.taskId);
  await vi.waitFor(() => expect(origin.ui.select.mock.calls.length, JSON.stringify(origin.api.sendMessage.mock.calls)).toBe(1));
  const path = join(persistence.graphRunsDir(origin.ctx.cwd), `${runId}.json`);
  {
    const shutdown = origin.lifecycle("session_shutdown");
    await releaseAfterPending(shutdown, () => human.resolve("Approve"));
    await shutdown;
  }
  // A live process still holds this run's lock across the resume.
  const release = persistence.ownGraphRun(origin.ctx.cwd, runId);
  const original = readFileSync(path, "utf8");
  const next = boot({ agentGraphEnabled: true }, "origin");
  const create = vi.spyOn(tasks, "createGraphRunTask");
  const remove = vi.spyOn(persistence, "deleteGraphSnapshot");
  // Force the peek to LOSE the race, then the lease to refuse the live owner.
  vi.spyOn(persistence, "graphRunHasLiveWriter").mockReturnValue(false);
  vi.spyOn(persistence, "ownGraphRun").mockImplementation(() => { throw new LiveWriterError(); });
  try {
    await next.lifecycle("session_start");
    // resume() must create the task (the peek reported no live writer) ...
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    // ... then the refused lease must settle silently: allow the background run and
    // the 200ms completion-nudge window to elapse, so any fabricated failure would fire.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(next.api.sendMessage).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    await next.lifecycle("session_shutdown");
    release();
  }
});

it("keeps checkpoint session ownership immutable under replacement", async () => {
  const session = boot({ agentGraphEnabled: true });
  await session.lifecycle("session_start");
  const human = deferred<string>();
  session.ui.select.mockReturnValue(human.promise);
  const result = await required(session.tools.get("agent_graph")).execute(
    "call", { graph: { nodes: { gate: gateGraph.nodes.gate }, edges: [] }, input: {} }, undefined, undefined, session.ctx,
  );
  const runId = required(result.details?.taskId);
  await vi.waitFor(() => expect(session.ui.select).toHaveBeenCalledOnce());
  const shutdown = session.lifecycle("session_shutdown");
  await releaseAfterPending(shutdown, () => human.resolve("Approve"));
  await shutdown;
  const path = join(persistence.graphRunsDir(session.ctx.cwd), `${runId}.json`);
  const original = readFileSync(path, "utf8");
  const saved = required(readGraphSnapshots(session.ctx.cwd).find(s => s.runId === runId));
  for (const owner of ["foreign", undefined, "", 42]) {
    const next = structuredClone(saved);
    required(next.state.runtime).revision++;
    if (owner === undefined) delete next.ownerSessionId;
    else Reflect.set(next, "ownerSessionId", owner);
    expect(() => persistence.writeGraphSnapshot(session.ctx.cwd, next)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  }
  const next = structuredClone(saved);
  required(next.state.runtime).revision++;
  persistence.writeGraphSnapshot(session.ctx.cwd, next);
  expect(required(readGraphSnapshots(session.ctx.cwd)[0]).ownerSessionId).toBe("parent");
  // Old ownerless checkpoints cannot be claimed by attaching the current session.
  delete saved.ownerSessionId;
  writeFileSync(path, JSON.stringify(saved));
  expect(() => persistence.writeGraphSnapshot(session.ctx.cwd, next)).toThrow();
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify(saved));
});
