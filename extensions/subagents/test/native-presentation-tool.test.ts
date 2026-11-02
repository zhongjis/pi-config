import { describe, expect, it } from "vitest";
import { projectNativeResult } from "../src/native-presentation.js";
import { renderAgentToolCall, renderAgentToolResult } from "../src/tool-rendering.js";
import type { AgentDetails } from "../src/ui/agent-format.js";
import { required } from "./graph-run-registration.fixture.js";
import { launchParams, presentationHost } from "./native-presentation.fixture.js";

const details: AgentDetails = {
  displayName: "Specialist", description: "Bounded task", subagentType: "fixture", agentId: "child-1",
  modelName: "provider/actual", toolUses: 3, tokens: "", durationMs: 2000, status: "running",
  activity: "reading files", result: "Latest response",
};

describe("model-facing delegation tool", () => {
  it("registers a callable tool with its launch schema and native final data", async () => {
    const host = presentationHost();
    const tool = required(host.tools.get("subagent"));
    expect(tool.parameters.properties).toHaveProperty("subagent_type");
    const result = await tool.execute("run", launchParams, undefined, undefined, host.context("run"));
    expect(result.details).toMatchObject({ results: [{ finished: true, exitCode: 0 }] });
  });
});

describe("historical agent renderer alias", () => {
  it("supplies terminal renderers for historical rows without replacing an existing renderer", () => {
    const host = presentationHost();
    const [resolve] = required(host.api.registerToolRenderer.mock.calls[0]);
    const renderers = { renderCall: renderAgentToolCall, renderResult: renderAgentToolResult };
    expect(resolve("agent", () => undefined)).toEqual(renderers);
    expect(resolve("agent", () => renderers)).toBe(renderers);
    expect(resolve("read", () => undefined)).toBeUndefined();
  });
});

describe("T3 entry projection", () => {
  it("puts activity before response and uses bounded task, display name and actual model", () => {
    expect(projectNativeResult(details)).toEqual({
      agent: "Specialist", task: "Bounded task", model: "provider/actual", step: 0, finished: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "reading files\nLatest response" }] }],
    });
  });

  it.each(["completed", "force_steered"] as const)("projects %s as successful completion", status => {
    expect(projectNativeResult({ ...details, status }, { finished: true })).toMatchObject({
      finished: true, exitCode: 0, messages: [{ content: [{ text: "Latest response" }] }],
    });
  });

  it.each(["stopped", "aborted"] as const)("projects %s as interruption with an assistant reason", status => {
    expect(projectNativeResult({ ...details, status, interruptionCause: "user", error: "AbortError: The operation was aborted." }, { finished: true })).toMatchObject({
      finished: true, stopReason: "aborted", errorMessage: "stopped by the user", messages: [{ content: [{ text: "stopped by the user" }] }],
    });
  });

  it("bounds only projected text, retaining the complete original result", () => {
    const full = { ...details, status: "completed" as const, result: "x".repeat(15_000) };
    const projected = projectNativeResult(full, { finished: true });
    expect(projected.messages[0]?.content[0]?.text).toHaveLength(10_000);
    expect(full.result).toHaveLength(15_000);
  });
});
