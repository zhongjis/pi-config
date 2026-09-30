import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boot, mockRunAgent, required, session } from "./graph-run-registration.fixture.js";

describe("registered result retrieval", () => {
  it("returns a durable human request before completion without opening UI", async () => {
    const host = boot({ agentGraphEnabled: true });
    await host.lifecycle("session_start");
    const launched = await required(host.tools.get("agent_graph")).execute("launch", {
      graph: { nodes: { gate: { type: "human_gate", prompt: "Approve release?", outputSchema: {
        type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false,
      } } }, edges: [], outputs: { decision: { node: "gate", path: "$" } } },
    }, undefined, undefined, host.ctx);
    const run_id = required(launched.details?.taskId);
    const result = await required(host.tools.get("get_agent_result")).execute("read", { run_id, wait: true }, undefined, undefined, host.ctx);
    expect(result.details, JSON.stringify(result)).toMatchObject({ kind: "graph", status: "running", gate: {
      gate_id: expect.any(String), revision: expect.any(String), kind: "human_gate", prompt: "Approve release?",
      response_schema: { allOf: expect.arrayContaining([expect.objectContaining({ properties: { approved: { type: "boolean" } } })]) },
    } });
    expect(host.ui.select).not.toHaveBeenCalled();
    const again = await required(host.tools.get("get_agent_result")).execute("again", { run_id, wait: true }, undefined, undefined, host.ctx);
    expect(again.details).toEqual(result.details);
  });
  it("waits for graph completion and returns its output", async () => {
    const host = boot({ agentGraphEnabled: true });
    await host.lifecycle("session_start");
    let release: (() => void) | undefined;
    const parked = new Promise<void>(resolve => { release = resolve; });
    mockRunAgent(async () => {
      await parked;
      return { responseText: "graph-result", session, aborted: false, steered: false };
    });
    const launched = await required(host.tools.get("agent_graph")).execute("launch", {
      graph: { nodes: { a: { type: "agent", agent: "fixture", prompt: "work" } }, edges: [], outputs: { answer: { node: "a", path: "$" } } },
    }, undefined, undefined, host.ctx);
    const id = required(launched.details?.taskId);
    let settled = false;
    const waiting = required(host.tools.get("get_agent_result")).execute("read", { run_id: id, wait: true }, undefined, undefined, host.ctx)
      .then(result => { settled = true; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled).toBe(false);
    } finally { required(release)(); }
    const result = await waiting;
    expect(result.content.map(part => part.text ?? "").join("\n")).toContain("graph-result");
    expect(result.content.map(part => part.text ?? "").join("\n")).toContain("completed");
  });
  it("retrieves an independent terminal agent through the canonical tool and legacy alias", async () => {
    const host = boot();
    await host.lifecycle("session_start");
    const launched = await required(host.tools.get("agent")).execute("launch", {
      subagent_type: "fixture", prompt: "independent-result", description: "result fixture",
    }, undefined, undefined, host.ctx);
    const text = launched.content.map(part => part.text ?? "").join("\n");
    const id = required(/Agent ID: (\S+)/.exec(text)?.[1]);
    expect(host.tools.has("get_agent_result")).toBe(true);
    for (const name of ["get_agent_result", "get_subagent_result"]) {
      const result = await required(host.tools.get(name)).execute("read", {
        ...(name === "get_agent_result" ? { run_id: id } : { agent_id: id }), wait: true,
      }, undefined, undefined, host.ctx);
      const body = result.content.map(part => part.text ?? "").join("\n");
      expect(body).toContain("independent-result");
      expect(body).not.toContain("Full result with every round:");
    }
  });
  it("returns compact bounded-feedback retrieval text and keeps rounds in the artifact and details", async () => {
    const host = boot({ agentGraphEnabled: true });
    await host.lifecycle("session_start");
    const round = `round-secret-${"x".repeat(800)}`;
    const prompts: string[] = [];
    mockRunAgent(async (_ctx, _type, prompt, options) => {
      prompts.push(prompt);
      options.onSessionCreated?.(session);
      const responseText = prompt.startsWith("EVAL")
        ? JSON.stringify({ decision: "sufficient", gaps: [], tasks: [] })
        : JSON.stringify({ blob: round });
      return { responseText, session, aborted: false, steered: false };
    });
    const launched = await required(host.tools.get("agent_graph")).execute("launch", {
      graph: {
        nodes: {
          research: {
            type: "bounded_feedback", name: "Research", maxIterations: 1, maxItemsPerIteration: 1, maxTotalItems: 1,
            work: {
              type: "fanout", items: { path: "$.tasks" },
              itemSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
              dispatch: { path: "$.query", cases: { q: "fixture" } }, prompt: "WORK " + "$" + "{item}",
              outputSchema: { type: "object", properties: { blob: { type: "string" } }, required: ["blob"], additionalProperties: false },
            },
            evaluator: { type: "agent", agent: "fixture", prompt: "EVAL " + "$" + "{feedback}" },
          },
        },
        edges: [],
        outputs: { topic: { path: "$.topic" } },
      },
      input: { topic: "compact", tasks: [{ query: "q" }] },
    }, undefined, undefined, host.ctx);
    const id = required(launched.details?.taskId);
    const result = await required(host.tools.get("get_agent_result")).execute("read", { run_id: id, wait: true }, undefined, undefined, host.ctx);
    const text = result.content.map(part => part.text ?? "").join("\n");
    expect(result.details, `${text}\n${prompts.join("\n---\n")}`).toMatchObject({
      kind: "graph", status: "completed",
      output: { feedback: { research: { iterations: expect.any(Array) } } },
    });
    const output = (result.details as { output?: { feedback?: { research?: { iterations?: unknown } } } } | undefined)?.output;
    expect(JSON.stringify(output?.feedback?.research?.iterations)).toContain(round);
    expect(text).not.toContain(round);
    expect(text).not.toContain('"iterations":[');
    const artifact = /Full result with every round: (\S+)/.exec(text)?.[1];
    expect(artifact, text).toMatch(/\.graph-result\.txt$/);
    expect(readFileSync(artifact as string, "utf-8")).toContain(round);
  });
});

describe("turn-boundary completion notifications", () => {
  const turnStart = { type: "turn_start", turnIndex: 0, timestamp: 0 };
  const finalTurn = {
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", stopReason: "stop", content: [] },
    toolResults: [],
  };
  const waitPastHold = () => new Promise((resolve) => setTimeout(resolve, 500));
  const notified = (host: ReturnType<typeof boot>, id: string) =>
    host.api.sendMessage.mock.calls.some(([message]) => String(message.content).includes(`<task-id>${id}</task-id>`));

  it("omits a collected background notification at the final turn", async () => {
    const host = boot();
    await host.lifecycle("session_start");
    await host.lifecycle("turn_start", turnStart);
    const launched = await required(host.tools.get("agent")).execute("launch", {
      subagent_type: "fixture", prompt: "bg-result", description: "parked", run_in_background: true,
    }, undefined, undefined, host.ctx);
    const id = required(/Agent ID: (\S+)/.exec(launched.content.map((part) => part.text ?? "").join("\n"))?.[1]);
    await waitPastHold();
    const result = await required(host.tools.get("get_agent_result")).execute("read", { run_id: id, wait: true }, undefined, undefined, host.ctx);
    expect(result.content.map((part) => part.text ?? "").join("\n")).toContain("bg-result");
    await host.lifecycle("turn_end", finalTurn);
    expect(notified(host, id)).toBe(false);
  });

  it("delivers an uncollected background notification at the final turn", async () => {
    const host = boot();
    await host.lifecycle("session_start");
    await host.lifecycle("turn_start", turnStart);
    const launched = await required(host.tools.get("agent")).execute("launch", {
      subagent_type: "fixture", prompt: "bg-open", description: "still parked", run_in_background: true,
    }, undefined, undefined, host.ctx);
    const id = required(/Agent ID: (\S+)/.exec(launched.content.map((part) => part.text ?? "").join("\n"))?.[1]);
    await waitPastHold();
    expect(notified(host, id)).toBe(false);
    await host.lifecycle("turn_end", finalTurn);
    expect(notified(host, id)).toBe(true);
    const call = required(host.api.sendMessage.mock.calls.find(([message]) => String(message.content).includes(`<task-id>${id}</task-id>`)));
    expect(call[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("omits a collected graph completion notification after the final turn", async () => {
    const host = boot({ agentGraphEnabled: true });
    await host.lifecycle("session_start");
    await host.lifecycle("turn_start", turnStart);
    let release: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => { release = resolve; });
    mockRunAgent(async () => {
      await parked;
      return { responseText: "graph-result", session, aborted: false, steered: false };
    });
    const launched = await required(host.tools.get("agent_graph")).execute("launch", {
      graph: { nodes: { a: { type: "agent", agent: "fixture", prompt: "work" } }, edges: [], outputs: { answer: { node: "a", path: "$" } } },
    }, undefined, undefined, host.ctx);
    const id = required(launched.details?.taskId);
    const waiting = required(host.tools.get("get_agent_result")).execute("read", { run_id: id, wait: true }, undefined, undefined, host.ctx);
    required(release)();
    const result = await waiting;
    expect(result.content.map((part) => part.text ?? "").join("\n")).toContain("graph-result");
    expect(result.content.map((part) => part.text ?? "").join("\n")).toContain("completed");
    await waitPastHold();
    await host.lifecycle("turn_end", finalTurn);
    expect(notified(host, id)).toBe(false);
  });
});
