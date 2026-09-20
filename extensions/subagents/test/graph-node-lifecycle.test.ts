import { describe, expect, it, vi } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { CompiledSchema } from "../src/graph/json-schema.js";
import { compileJsonSchema } from "../src/graph/json-schema.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import type { AgentLifecycleInput } from "../src/graph/node-lifecycle-session.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { agentInput, terminal } from "./graph-node-machine.fixture.js";

function compile(schema: unknown): CompiledSchema {
  const c = compileJsonSchema(schema);
  if (!c.ok) throw new Error(c.message);
  return c.compiled;
}

function runNode(input: AgentLifecycleInput): Promise<NodeSpawnResult> {
  return terminal(input).then(({ result }) => result);
}
const base = (host: NodeHost, over?: Partial<AgentLifecycleInput["node"]>): AgentLifecycleInput =>
  agentInput({ host, node: { ...agentInput().node, ...over } });

describe("agentNodeLogic — deterministic gate validation", () => {
  it("completes when the gate passes", async () => {
    const host: NodeHost = {
      spawnAgent: async () => ({ ok: true, output: "done", cwd: "/w" }),
      runGate: async () => ({ ok: true, output: "" }),
    };
    const result = await runNode(base(host, { gate: "npm test" }));
    expect(result.ok).toBe(true);
  });

  it("fails the node when the gate fails, surfacing the gate output", async () => {
    const host: NodeHost = {
      spawnAgent: async () => ({ ok: true, output: "done" }),
      runGate: async () => ({ ok: false, output: "2 tests failed" }),
    };
    const result = await runNode(base(host, { gate: "npm test" }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("2 tests failed");
  });

  it("fails loudly when a gate is requested but the host cannot run one", async () => {
    const host: NodeHost = { spawnAgent: async () => ({ ok: true, output: "done" }) };
    const result = await runNode(base(host, { gate: "npm test" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot run gate");
  });
});

describe("agentNodeLogic — bounded retry", () => {
  it("retries a validation failure and succeeds within maxAttempts", async () => {
    const schema = compile({ type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] });
    let calls = 0;
    const host: NodeHost = {
      spawnAgent: async () => {
        calls++;
        return { ok: true, output: calls >= 2 ? '{"approved":true}' : '{"approved":"no"}' };
      },
    };
    const result = await runNode(base(host, { schema, maxAttempts: 2 }));
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("fails after exhausting maxAttempts", async () => {
    const schema = compile({ type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] });
    let calls = 0;
    const host: NodeHost = {
      spawnAgent: async () => {
        calls++;
        return { ok: true, output: '{"approved":"no"}' };
      },
    };
    const result = await runNode(base(host, { schema, maxAttempts: 2 }));
    expect(result.ok).toBe(false);
    expect(calls).toBe(2);
  });

  it("does not retry a user skip", async () => {
    let calls = 0;
    const host: NodeHost = {
      spawnAgent: async () => {
        calls++;
        return { ok: false, skipped: true, error: "Skipped by user." };
      },
    };
    const result = await runNode(base(host, { maxAttempts: 3 }));
    expect(result.skipped).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("correlated ordinary repair", () => {
  it.each(["schema", "gate"] as const)("%s repair preserves graph-start counters", async kind => {
    let executions = 0;
    const graph: AgentGraph = {
      version: 2,
      nodes: { worker: {
        type: "agent", agent: "worker", prompt: "fixture", retry: { maxAttempts: 2 },
        ...(kind === "schema" ? { outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] } } : { validation: { gate: "true" } }),
      } },
      edges: [],
    };
    const result = await runGraph(graph, {}, {
      onCheckpoint: () => {},
      host: {
        spawnAgent: async () => {
          executions++;
          return { ok: true, output: kind === "schema" && executions === 1 ? '{"approved":"no"}' : '{"approved":true}' };
        },
        ...(kind === "gate" ? { runGate: async () => ({ ok: executions === 2, output: "repair" }) } : {}),
      },
    });
    expect(executions).toBe(2);
    expect(result.nodes.worker).toMatchObject({ attempt: 1, activation: 1, graphAttempt: 1 });
  });

  it("restoring the second admission never replenishes its repair budget", async () => {
    const graph: AgentGraph = {
      version: 2,
      nodes: { worker: {
        type: "agent", agent: "worker", prompt: "fixture", retry: { maxAttempts: 2 },
        outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
      } },
      edges: [],
    };
    const controller = new AbortController();
    let initialExecutions = 0;
    let releaseInterrupted: ((result: NodeSpawnResult) => void) | undefined;
    let checkpoint: { state: SchedulerState; graph: AgentGraph } | undefined;
    const interrupted = runGraph(graph, {}, {
      signal: controller.signal,
      onCheckpoint: (state, effective) => {
        if (checkpoint === undefined && state.nodes.worker.status === "running" && state.runtime?.executionLedger?.filter(row => "payload" in row && row.payload.kind === "admitted").length === 2) checkpoint = { state, graph: effective };
      },
      host: {
        spawnAgent: async () => {
          initialExecutions++;
          if (initialExecutions === 1) return { ok: true, output: '{"approved":"no"}' };
          return new Promise<NodeSpawnResult>(resolve => { releaseInterrupted = resolve; });
        },
      },
    });
    await vi.waitFor(() => expect(checkpoint).toBeDefined());
    controller.abort();
    const release = releaseInterrupted;
    if (!release) throw new Error("Interrupted repair did not start");
    release({ ok: true, output: '{"approved":true}' });
    expect((await interrupted).status).toBe("aborted");
    const saved = checkpoint;
    if (!saved) throw new Error("Missing mid-repair checkpoint");
    let restoredExecutions = 0;
    const restored = await runGraph(saved.graph, {}, {
      restore: saved.state, reclaimedDeadWriter: true,
      onCheckpoint: () => {},
      host: { reconcileDrain: async () => true, spawnAgent: async () => { restoredExecutions++; return { ok: true, output: '{"approved":"no"}' }; } },
    });
    expect(restoredExecutions).toBe(0);
    expect(restored.nodes.worker).toMatchObject({ attempt: 1, activation: 1, graphAttempt: 1, status: "failed" });
  });
});
