import { describe, expect, it } from "vitest";
import type { CompiledSchema } from "../src/graph/json-schema.js";
import { compileJsonSchema } from "../src/graph/json-schema.js";
import type { NodeHost, NodeSpawnRequest, NodeSpawnResult } from "../src/graph/node-host.js";
import { deferred, releaseAfterPending } from "./graph-drain.fixture.js";
import { agentInput, machine, terminal } from "./graph-node-machine.fixture.js";

function compile(schema: unknown): CompiledSchema {
  const c = compileJsonSchema(schema);
  if (!c.ok) throw new Error(c.message);
  return c.compiled;
}

function req(over?: Partial<NodeSpawnRequest>): NodeSpawnRequest {
  return { nodeId: "a", attempt: 1, agentType: "jintong", prompt: "do it", ...over };
}

/** Start a node actor and resolve with its settled output. */
function runToDone(host: NodeHost, request: NodeSpawnRequest): Promise<NodeSpawnResult> {
  return terminal(agentInput({ host, node: { ...request, kind: "agent" } })).then(({ result }) => result);
}

/** A host that always returns the same result. */
function fixedHost(result: NodeSpawnResult): NodeHost {
  return { spawnAgent: async () => result };
}

describe("agentNodeLogic — spawn + schema re-check", () => {
  it("returns plain text output when no schema is requested", async () => {
    const result = await runToDone(fixedHost({ ok: true, output: "hello" }), req());
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
  });

  it("accepts structured output that matches the schema", async () => {
    const schema = compile({ type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] });
    const result = await runToDone(fixedHost({ ok: true, output: '{"approved":true}' }), req({ schema }));
    expect(result.ok).toBe(true);
    expect(result.output).toBe('{"approved":true}');
  });

  it("fails a node whose structured output violates the schema", async () => {
    const schema = compile({ type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] });
    const result = await runToDone(fixedHost({ ok: true, output: '{"approved":"yes"}' }), req({ schema }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not match the requested schema");
  });

  it("fails a node that returns non-JSON when a schema is required", async () => {
    const schema = compile({ type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] });
    const result = await runToDone(fixedHost({ ok: true, output: "not json" }), req({ schema }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("was not JSON");
  });

  it("passes a failed spawn through unchanged, without applying the schema", async () => {
    const schema = compile({ type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] });
    const result = await runToDone(fixedHost({ ok: false, error: "boom" }), req({ schema }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
  });
});

describe("agentNodeLogic — cancellation", () => {
  it("aborts the child's signal when the actor is stopped", async () => {
    let captured: AbortSignal | undefined;
    const execution = deferred<NodeSpawnResult>();
    const host: NodeHost = {
      spawnAgent: (_request, signal) => { captured = signal; return execution.promise; },
    };
    const actor = machine(agentInput({ host }));
    actor.admit();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);
    actor.parent.stop();
    expect(captured?.aborted).toBe(true);
    await releaseAfterPending(execution.promise, () => execution.resolve({ ok: true }));
  });
});
