import { describe, expect, it } from "vitest";
import { boot, required } from "./workflow-registration.fixture.js";

/** Drives the registered agent_graph tool through the booted extension. */
describe("agent_graph tool", () => {
  it("runs an inline graph in the background and notifies on completion", async () => {
    const host = boot({ workflowsEnabled: true });
    await host.lifecycle("session_start");
    const tool = required(host.tools.get("agent_graph"));

    const graph = {
      name: "demo",
      nodes: {
        a: { type: "agent", agent: "fixture", prompt: "do a" },
        b: { type: "agent", agent: "fixture", prompt: "do b" },
      },
      edges: [{ from: "a", to: "b" }],
      outputs: { r: { node: "b", path: "$" } },
    };

    const result = await tool.execute("call", { graph, input: {} }, undefined, undefined, host.ctx);
    const taskId = required(result.details?.taskId);
    expect(result.content[0]?.text).toContain("started in the background");

    const message = await host.notification(taskId);
    expect(message.content).toContain(`<task-id>${taskId}</task-id>`);
    expect(message.content).toContain("Execution: completed");
  });

  it("rejects an invalid inline graph before starting a run", async () => {
    const host = boot({ workflowsEnabled: true });
    await host.lifecycle("session_start");
    const tool = required(host.tools.get("agent_graph"));
    await expect(
      tool.execute("call", { graph: { nodes: {}, edges: [] } }, undefined, undefined, host.ctx),
    ).rejects.toThrow(/Invalid agent graph/);
  });

  it("is not registered when workflows are disabled", () => {
    const host = boot();
    expect(host.tools.has("agent_graph")).toBe(false);
  });
});
