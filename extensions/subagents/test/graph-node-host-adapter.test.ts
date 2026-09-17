import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { createNodeHost } from "../src/graph/node-host-adapter.js";
import { runGraph } from "../src/graph/run-graph.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

import { runAgent } from "../src/agent-runner.js";

const ui: Pick<ExtensionContext["ui"], "notify"> = { notify: vi.fn() };
const ctx = {
  cwd: "/tmp",
  modelRegistry: {} as ExtensionContext["modelRegistry"],
  model: undefined,
  sessionManager: { getSessionId: () => "parent" } as ExtensionContext["sessionManager"],
  ui: ui as ExtensionContext["ui"],
} as ExtensionContext;

const session = () => ({ dispose: vi.fn() }) as unknown as AgentSession;

let manager: AgentManager;
afterEach(() => {
  manager?.dispose();
  vi.resetAllMocks();
});

function setup(responseText = "done") {
  manager = new AgentManager();
  const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: "passed", stderr: "", killed: false });
  const pi: Pick<ExtensionAPI, "exec"> = { exec };
  const host = createNodeHost({ pi: pi as ExtensionAPI, ctx, manager, workflowId: "wf", outputTranscript: () => false });
  vi.mocked(runAgent).mockImplementation(async () => ({ session: session(), responseText, aborted: false, steered: false }));
  return { host, exec };
}

describe("createNodeHost", () => {
  it("maps a completed agent record to a NodeSpawnResult", async () => {
    const { host } = setup("hello");
    const result = await host.spawnAgent(
      { nodeId: "a", attempt: 1, agentType: "general-purpose", prompt: "task" },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
    await host.dispose();
  });

  it("runs a gate command via pi.exec", async () => {
    const { host, exec } = setup();
    const gate = await host.runGate?.("true", { signal: new AbortController().signal });
    expect(gate?.ok).toBe(true);
    expect(exec).toHaveBeenCalled();
    await host.dispose();
  });

  it("executes a whole graph through the real adapter", async () => {
    const { host } = setup("out");
    const graph: AgentGraph = {
      nodes: {
        a: { type: "agent", agent: "general-purpose", prompt: "a" },
        b: { type: "agent", agent: "general-purpose", prompt: "b" },
      },
      edges: [{ from: "a", to: "b" }],
      outputs: { r: { node: "b", path: "$" } },
    };
    const result = await runGraph(graph, {}, { host });
    expect(result.status).toBe("completed");
    expect(result.outputs).toEqual({ r: "out" });
    await host.dispose();
  });
});
