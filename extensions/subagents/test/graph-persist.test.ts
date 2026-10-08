import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GraphRunSnapshot, graphRunsDir, readGraphSnapshots, writeGraphSnapshot } from "../src/graph/graph-persist.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { ProjectionDriver as Scheduler } from "./graph-projection.fixture.js";

const agent = () => ({ type: "agent" as const, agent: "x", prompt: "p" });

const gateGraph: AgentGraph = {
  nodes: {
    a: agent(),
    gate: {
      type: "decision_gate",
      state: {},
      questions: { approved: { type: "bool", instructions: "approve?", criteria: { true: "yes", false: "no" } } },
    },
    done: agent(),
  },
  edges: [
    { from: "a", to: "gate" },
    { from: "gate", to: "done", when: { eq: [{ node: "gate", path: "$.answers.approved.value" }, true] } },
  ],
  outputs: { decision: { node: "gate", path: "$.answers.approved.value" } },
};

describe("Scheduler snapshot/hydrate", () => {
  it("round-trips completed node state", () => {
    const graph: AgentGraph = { nodes: { a: agent(), b: agent() }, edges: [{ from: "a", to: "b" }] };
    const s = new Scheduler(graph, {});
    s.markRunning("a");
    s.settle("a", { ok: true, output: { x: 1 } });
    const state = s.snapshotState();
    expect(state.nodes.a.status).toBe("completed");
    expect(state.nodes.a.output).toEqual({ x: 1 });

    const restored = new Scheduler(graph, {});
    restored.hydrate(state);
    expect(restored.nodes.get("a")?.status).toBe("completed");
    expect(restored.nodes.get("a")?.output).toEqual({ x: 1 });
  });

  it("hydrates a mid-flight (running) node back to pending", () => {
    const graph: AgentGraph = { nodes: { a: agent() }, edges: [] };
    const s = new Scheduler(graph, {});
    s.markRunning("a");
    const restored = new Scheduler(graph, {});
    restored.hydrate(s.snapshotState());
    expect(restored.nodes.get("a")?.status).toBe("pending");
  });
});

describe("runGraph durable resume", () => {
  it("fires onGateWaiting with the current run state when a gate awaits", async () => {
    const captured: { id: string; state: SchedulerState }[] = [];
    const host: NodeHost = {
      spawnAgent: async () => ({ ok: true, output: "a-out" }),
      decide: async () => ({ ok: false, error: "unavailable" }),
      awaitEscalation: async () => ({ ok: true, output: '{"answers":{"approved":true},"decidedBy":"human"}' }),
    };
    await runGraph(gateGraph, {}, { host, onGateWaiting: (id, state) => captured.push({ id, state }) });
    expect(captured).toHaveLength(1);
    expect(captured[0].id).toBe("gate");
    expect(captured[0].state.nodes.a.status).toBe("completed");
    expect(captured[0].state.nodes.gate.status).toBe("running");
  });
});

describe("graph checkpoint snapshots", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
  async function saved(owner: string): Promise<{ cwd: string; snapshot: GraphRunSnapshot }> {
    const cwd = mkdtempSync(join(tmpdir(), "graph-persist-")); dirs.push(cwd);
    const graph: AgentGraph = { nodes: { a: agent() }, edges: [] };
    const runId = "agr_abcdef123456";
    let snapshot: GraphRunSnapshot | undefined;
    await runGraph(graph, {}, { runId, host: { spawnAgent: async () => ({ ok: true, output: "x" }) }, onCheckpoint: (state, effective) => {
      snapshot = structuredClone({ version: 2, runId, ownerSessionId: owner, graph: effective, input: {}, waitingGate: "", savedAt: 0, state });
      writeGraphSnapshot(cwd, snapshot);
    } });
    if (!snapshot) throw new Error("missing fixture");
    return { cwd, snapshot };
  }

  it("skips a snapshot owned by another session", async () => {
    const { cwd, snapshot } = await saved("owner");
    const invalid = vi.fn();
    expect(readGraphSnapshots(cwd, invalid, "someone-else")).toEqual([]);
    expect(readGraphSnapshots(cwd, invalid, "owner")).toEqual([snapshot]);
    expect(invalid).not.toHaveBeenCalled();
  });

  it.each(["human_gate", "agent_gate", "hybrid_gate"])("reports a checkpoint using the removed %s node type", async type => {
    const { cwd, snapshot } = await saved("owner");
    const file = join(graphRunsDir(cwd), `${snapshot.runId}.json`);
    const forged = JSON.parse(readFileSync(file, "utf8"));
    forged.graph.nodes.a.type = type;
    writeFileSync(file, JSON.stringify(forged));
    const invalid = vi.fn();
    expect(readGraphSnapshots(cwd, invalid)).toEqual([]);
    expect(invalid).toHaveBeenCalledWith(expect.stringContaining(`removed node type "${type}"; start a new run.`));
  });
});
