import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import type { CompiledSchema } from "../src/graph/json-schema.js";
import { compileJsonSchema } from "../src/graph/json-schema.js";
import { type NodeExecInput, nodeLogic } from "../src/graph/node-actor.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";

function compile(schema: unknown): CompiledSchema {
  const c = compileJsonSchema(schema);
  if (!c.ok) throw new Error(c.message);
  return c.compiled;
}

function runNode(input: NodeExecInput): Promise<NodeSpawnResult> {
  const actor = createActor(nodeLogic, { input });
  return new Promise<NodeSpawnResult>(resolve => {
    actor.subscribe(snapshot => {
      if (snapshot.status === "done") resolve(snapshot.output as NodeSpawnResult);
    });
    actor.start();
  });
}

const base = (host: NodeHost, over?: Partial<NodeExecInput>): NodeExecInput => ({
  host,
  nodeId: "n",
  agentType: "x",
  prompt: "p",
  ...over,
});

describe("nodeLogic — deterministic gate validation", () => {
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

describe("nodeLogic — bounded retry", () => {
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
