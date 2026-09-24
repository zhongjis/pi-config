import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { type ExecutionCorrelation, executionAttemptId } from "../src/graph/graph-execution.js";
import type { NodeInstanceId } from "../src/graph/graph-instance-id.js";
import { GraphRunReporter } from "../src/graph/graph-run-adapter.js";
import { decodeHistory, snapshotHistory } from "../src/graph/history.js";
import { mergeGraphRuns } from "../src/graph/history-view.js";
import { createNodeHost } from "../src/graph/node-host-adapter.js";
import { toPaneSource } from "../src/graph/pane/render.js";
import { collapse } from "../src/graph/progress.js";
import { createGraphRunTask } from "../src/graph/task.js";
import { initialPanelState, renderPanelLines } from "../src/ui/observability-panel.js";

vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

import { runAgent } from "../src/agent-runner.js";

let manager: AgentManager;
beforeEach(() => {
  registerAgents(new Map());
  manager = new AgentManager();
});
afterEach(() => {
  manager.dispose();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function setup() {
  const pi: Pick<ExtensionAPI, "exec"> = { exec: vi.fn() };
  const ctx = { cwd: "/tmp", modelRegistry: {}, model: undefined } as ExtensionContext;
  return { host: createNodeHost({ pi: pi as ExtensionAPI, ctx, manager, graphRunId: "wf", outputTranscript: () => false }) };
}

function assistant(modelId: string): AssistantMessage {
  return {
    role: "assistant", provider: "test", model: modelId, api: "openai-responses",
    content: [{ type: "text", text: "result" }], stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

it.each(["normal", "switch", "failure", "no-evidence", "early-session", "missing-provider"] as const)(
  "reports only this execution's assistant model live and in settled history: %s", async scenario => {
    const { host } = setup();
    const task = createGraphRunTask({ id: "provenance", script: "" });
    const reporter = new GraphRunReporter(task, { nodes: { a: { type: "agent", agent: "general-purpose", prompt: "task" } }, edges: [] });
    const identity: ExecutionCorrelation = { runId: "provenance", instanceId: "11111111-1111-4111-8111-111111111111" as NodeInstanceId, activation: 1, graphAttempt: 1, executionAttemptId: executionAttemptId("22222222-2222-4222-8222-222222222222") };
    const running = { status: "running" as const, attempt: 1, activation: 1, graphAttempt: 1, currentExecutionAttemptId: identity.executionAttemptId };
    reporter.update("a", running, identity);
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const child = {
      model: { provider: "test", id: "selected-not-executed", name: "Selected only" },
      messages: [assistant("unrelated-inherited-model")],
      dispose: vi.fn(),
      subscribe: (listener: (event: AgentSessionEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    } as unknown as AgentSession;
    const emit = (modelId: string) => {
      const message = assistant(modelId);
      if (scenario === "missing-provider") Reflect.deleteProperty(message, "provider");
      for (const listener of listeners) listener({ type: "message_end", message });
    };
    if (scenario === "early-session") {
      const spawnAndWait = manager.spawnAndWait.bind(manager);
      vi.spyOn(manager, "spawnAndWait").mockImplementation(async (pi, context, type, prompt, options, onSpawned) => {
        const result = await spawnAndWait(pi, context, type, prompt, options);
        onSpawned?.(result.id);
        return result;
      });
    }
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(child);
      expect(collapse(task.graphRunProgress).agents[0]?.modelId).toBeUndefined();
      if (scenario !== "no-evidence") {
        emit("first-model");
        expect(collapse(task.graphRunProgress).agents[0]?.modelId).toBe("first-model");
        expect(collapse(task.graphRunProgress).agents[0]?.model).toBe(scenario === "missing-provider" ? "first-model" : "test/first-model");
        if (scenario === "switch" || scenario === "failure") {
          emit("actual-fallback");
          expect(collapse(task.graphRunProgress).agents[0]?.modelId).toBe("actual-fallback");
        }
      }
      if (scenario === "failure") throw new Error("provider failed after assistant");
      return { session: child, responseText: "done", aborted: false, steered: false };
    });
    const result = await host.spawnAgent({ nodeId: "a", attempt: 1, agentType: "general-purpose", prompt: "task", correlation: identity, onResolved: info => reporter.setResolved("a", info, identity) }, new AbortController().signal);
    expect(result.ok).toBe(scenario !== "failure");
    reporter.update("a", { ...running, status: result.ok ? "completed" : "failed", output: result.output, error: result.error }, identity);
    Object.assign(task, { status: result.ok ? "completed" : "failed", endTime: Date.now() });
    const expected = scenario === "no-evidence" ? undefined : scenario === "switch" || scenario === "failure" ? "actual-fallback" : "first-model";
    expect(collapse(task.graphRunProgress).agents[0]?.modelId).toBe(expected);
    const snapshot = snapshotHistory(task);
    expect(snapshot?.nodes[0]?.modelId).toBe(expected);
    const saved = decodeHistory(JSON.stringify({ version: 2, runs: [snapshot] })).runs;
    const history = mergeGraphRuns([], saved).get(task.id);
    if (!history) throw new Error("Missing history fixture");
    const source = toPaneSource(history);
    for (const [run, modelName, nodeId] of [
      [task, expected && (scenario === "missing-provider" ? expected : `test/${expected}`), "a"],
      [history, expected, 0],
    ] as const) {
      for (const width of [40, 100]) {
        const lines = renderPanelLines(
          [{ id: task.id, name: "provenance", status: run.status, source: toPaneSource(run) }],
          { ...initialPanelState(), cursor: { kind: "node", id: nodeId }, focus: "detail" },
          { width },
        ).map(line => line.map(segment => segment.text).join(""));
        const panel = lines.join("\n");
        expect(panel).not.toMatch(/selected-not-executed|unrelated-inherited-model/);
        expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
        if (modelName) {
          // At 40 columns the kind/type prefix can clip model metadata entirely.
          // The wider selected-node view must show the full effective name.
          if (width === 100) expect(panel).toContain(modelName);
        } else {
          expect(panel).not.toMatch(/first-model|actual-fallback|test\//);
          expect(collapse(toPaneSource(run).progress).agents[0]?.modelId).toBeUndefined();
        }
      }
    }
    expect(collapse(source.progress).agents[0]?.modelId).toBe(expected);
    expect(listeners.size).toBe(0);
    await host.dispose();
  },
);
