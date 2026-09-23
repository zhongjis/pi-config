import { describe, expect, it, vi } from "vitest";
import { boot, plainTheme, required } from "./workflow-registration.fixture.js";

// Stub keyHint so renderResult can be exercised without a real TUI theme.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, keyHint: (_key: string, label?: string) => label ?? "" };
});

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
    // A completed graph with no declared outcome defaults its objective outcome to "Completed".
    expect(message.content).toContain("<status>Completed</status>");
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

  const flat = (c: { render(w: number): string[] }) => c.render(120).join("\n");

  it("renders 'diagnostics' expand label on isError (L3)", () => {
    const host = boot({ workflowsEnabled: true });
    const tool = required(host.tools.get("agent_graph"));
    const result = { content: [{ type: "text", text: "boom" }] };
    const rendered = flat(tool.renderResult(result, { expanded: false }, plainTheme, { isError: true }));
    expect(rendered).toContain("Failed");
    expect(rendered).toContain("diagnostics");
  });

  it("hints at /agents when task not in session (L4)", async () => {
    const host = boot({ workflowsEnabled: true });
    await host.lifecycle("session_start");
    const tool = required(host.tools.get("agent_graph"));
    const ghostResult = {
      content: [{ type: "text", text: 'Agent graph "x" started in the background.\nTask ID: ghost123\nYou will be notified.' }],
      details: { taskId: "ghost123" },
    };
    const collapsed = flat(tool.renderResult(ghostResult, { expanded: false }, plainTheme, { isError: false }));
    expect(collapsed).toContain("/agents");
    const expanded = flat(tool.renderResult(ghostResult, { expanded: true }, plainTheme, { isError: false }));
    expect(expanded).toContain("Task ID: ghost123");
  });

  it("renders via workflow card for a live task, not the fallback (G1)", async () => {
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
    await host.notification(taskId);
    const collapsed = flat(tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }));
    expect(collapsed).not.toContain("Live graph state unavailable");
    // renderCall smoke check
    const call = (tool as unknown as { renderCall(args: unknown, theme: unknown): { render(w: number): string[] } }).renderCall({ graph }, plainTheme);
    const callRendered = flat(call);
    expect(callRendered).toContain("agent_graph");
    expect(callRendered).toContain("demo");
  });

  it("renders completed graph details with exact tree connectors", async () => {
    const host = boot({ workflowsEnabled: true });
    await host.lifecycle("session_start");
    const tool = required(host.tools.get("agent_graph"));
    const graph = {
      name: "tree-demo",
      nodes: {
        summary: { type: "agent", agent: "fixture", prompt: "summary" },
        relevantFiles: { type: "agent", agent: "fixture", prompt: "files" },
        constraints: { type: "agent", agent: "fixture", prompt: "constraints" },
        unknowns: { type: "agent", agent: "fixture", prompt: "unknowns" },
        extra: { type: "agent", agent: "fixture", prompt: "extra" },
      },
      edges: [],
      outputs: {
        summary: { node: "summary", path: "$" },
        relevantFiles: { node: "relevantFiles", path: "$" },
        constraints: { node: "constraints", path: "$" },
        unknowns: { node: "unknowns", path: "$" },
      },
    };
    const result = await tool.execute("tree-call", { graph, input: {} }, undefined, undefined, host.ctx);
    await host.notification(required(result.details?.taskId));
    expect(flat(tool.renderResult(result, { expanded: false }, plainTheme, { isError: false })).split("\n")).toEqual([
      "├─ outcome: not declared",
      "├─ execution: completed · 5 agents completed",
      "├─ result: summary, relevantFiles, constraints, unknowns",
      "└─ result and diagnostics · /agents › Graph runs",
    ]);
  });
});
