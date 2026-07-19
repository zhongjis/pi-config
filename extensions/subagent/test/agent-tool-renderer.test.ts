import { describe, expect, it } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { formatAgentFailureOutput, renderAgentToolCall, renderAgentToolResult } from "../src/tools/agent.js";
import { renderGetSubagentResult, renderGetSubagentResultCall } from "../src/tools/get_subagent_result.js";
import type { AgentDetails } from "../src/ui/agent-widget.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function textOf(component: unknown): string {
  return (component as { text: string }).text;
}

function result(text: string, details: AgentDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}
registerAgents(new Map([["taishang", {
  name: "taishang",
  displayName: "Taishang 太上老君",
  description: "",
  extensions: true,
  skills: true,
  systemPrompt: "",
  promptMode: "replace",
}]]));

const runningDetails: AgentDetails = {
  displayName: "Taishang 太上老君",
  description: "Assess verify failure",
  subagentType: "taishang",
  status: "running",
  activity: "thinking",
  modelName: undefined,
  tags: ["thinking: high"],
  turnCount: 6,
  maxTurns: undefined,
  toolUses: 11,
  tokens: "134.6k",
  durationMs: 12_000,
};

describe("Agent tool TUI rendering", () => {
  it("renders call header with one agent/title owner", () => {
    const rendered = textOf(renderAgentToolCall({ subagent_type: "taishang", description: "Assess verify failure" }, theme));

    expect(rendered).toBe("▸ Taishang 太上老君 · Assess verify failure");
  });

  it("renders running partial as lifecycle plus useful activity", () => {
    const rendered = textOf(renderAgentToolResult(result("raw model-visible text", {
      ...runningDetails,
      activity: "reading src/tools/agent.ts",
    }), { expanded: false, isPartial: true }, theme));

    expect(rendered).toContain("├─ status: running");
    expect(rendered).toContain("├─ activity: reading src/tools/agent.ts");
    expect(rendered).toContain("├─ model: thinking high · ↻6");
    expect(rendered).toContain("├─ tools: 11");
    expect(rendered).toContain("├─ context: 134.6k");
    expect(rendered).toContain("└─ app.tools.expand to expand full result");
    expect(rendered).not.toContain("Taishang 太上老君");
    expect(rendered).not.toContain("Assess verify failure");
  });

  it("suppresses placeholder activity and zero background stats", () => {
    const rendered = textOf(renderAgentToolResult(result("Agent started in background.", {
      ...runningDetails,
      status: "background",
      activity: "thinking",
      agentId: "agent-123",
      toolUses: 0,
      tokens: "",
      durationMs: 0,
      turnCount: undefined,
      tags: undefined,
    }), { expanded: false }, theme));

    expect(rendered).toContain("├─ status: started");
    expect(rendered).toContain("├─ agent: agent-123");
    expect(rendered).toContain("├─ next: get_subagent_result wait:false");
    expect(rendered).not.toContain("activity:");
    expect(rendered).not.toContain("tools: 0");
    expect(rendered).not.toContain("duration: 0.0s");
  });

  it("returns exact raw content when expanded", () => {
    const raw = "Agent completed in 10s.\n\nFull raw result\nwith lines.";
    const rendered = textOf(renderAgentToolResult(result(raw, { ...runningDetails, status: "completed", activity: undefined }), { expanded: true }, theme));

    expect(rendered).toBe(raw);
  });

  it("renders typed continuation outcomes while keeping expanded raw text exact", () => {
    const raw = "Agent failed to restore /home/user/private/session.jsonl.\nError: internal stack";
    const failedDetails: AgentDetails = {
      ...runningDetails,
      status: "error",
      invocationStatus: "failed",
      failureReason: "session_corrupt_or_unsupported",
      error: "Internal restore error at /home/user/private/session.jsonl\nstack",
    };
    const collapsed = textOf(renderAgentToolResult(result(raw, failedDetails), { expanded: false }, theme));
    const expanded = textOf(renderAgentToolResult(result(raw, failedDetails), { expanded: true }, theme));

    expect(collapsed).toContain("├─ status: error");
    expect(collapsed).toContain("├─ continuation: failed");
    expect(collapsed).toContain("├─ reason: session_corrupt_or_unsupported");
    expect(collapsed).not.toContain("/home/user/private/session.jsonl");
    expect(collapsed).not.toContain("Internal restore error");
    expect(expanded).toBe(raw);
  });

  it.each(["resumed_live", "restored_session"] as const)("renders %s continuation outcome", invocationStatus => {
    const rendered = textOf(renderAgentToolResult(result("continued", {
      ...runningDetails,
      status: "completed",
      activity: undefined,
      invocationStatus,
    }), { expanded: false }, theme));

    expect(rendered).toContain(`├─ continuation: ${invocationStatus}`);
    expect(rendered).not.toContain("reason:");
  });

  it("renders policy denial semantics without calling it a continuation failure", () => {
    const colors: Array<{ color: string; text: string }> = [];
    const semanticTheme = {
      fg: (color: string, text: string) => { colors.push({ color, text }); return text; },
      bold: (text: string) => text,
    };
    const raw = "Delegation policy denied agent target.\nFull policy detail.";
    const deniedDetails: AgentDetails = {
      ...runningDetails,
      status: "error",
      invocationStatus: "failed",
      category: "delegation_policy_denied",
      permittedTypes: ["jintong", "yunu"],
    };

    const collapsed = textOf(renderAgentToolResult(result(raw, deniedDetails), { expanded: false }, semanticTheme));
    const expanded = textOf(renderAgentToolResult(result(raw, deniedDetails), { expanded: true }, semanticTheme));

    expect(collapsed).toContain("├─ status: denied");
    expect(collapsed).toContain("├─ invocation: failed");
    expect(collapsed).toContain("├─ reason: delegation_policy_denied");
    expect(collapsed).toContain("├─ permitted: jintong, yunu");
    expect(collapsed).not.toContain("continuation:");
    expect(colors).toContainEqual({ color: "error", text: "├─ status: denied" });
    expect(colors).toContainEqual({ color: "toolOutput", text: "├─ reason: delegation_policy_denied" });
    expect(colors).toContainEqual({ color: "muted", text: "└─ app.tools.expand to expand full result" });
    expect(expanded).toBe(raw);
  });

  it("formats model-visible failures with error before labeled partial output", () => {
    const text = formatAgentFailureOutput({
      status: "error",
      error: "provider stream failed",
      result: "PARTIAL OUTPUT",
      toolUses: 0,
    });

    expect(text).toBe(
      "Agent failed: provider stream failed\n\n" +
      "Partial output before the failure:\nPARTIAL OUTPUT",
    );
  });

  it("formats synthesized recovery diagnostics unlabeled when result already matches recovery", () => {
    const recovered = [
      "Agent failed before producing a final answer.",
      "Error: provider unavailable",
      "Tool uses before exit: 3",
      "Transcript file: /tmp/agent-output.jsonl",
    ].join("\n\n");
    const text = formatAgentFailureOutput({
      status: "error",
      error: "provider unavailable",
      result: recovered,
      toolUses: 3,
      outputFile: "/tmp/agent-output.jsonl",
    }, "\nSession log: child-session.jsonl", "\nHint: local:// is parent-scoped");

    expect(text).toBe(
      "Agent failed: provider unavailable\nSession log: child-session.jsonl\n\n" +
      recovered +
      "\nHint: local:// is parent-scoped",
    );
    expect(text).not.toContain("Partial output before the failure");
  });

  it("formats missing model-visible failures with computed recovery diagnostics unlabeled", () => {
    const text = formatAgentFailureOutput({
      status: "error",
      error: "provider unavailable",
      result: undefined,
      toolUses: 3,
      outputFile: "/tmp/agent-output.jsonl",
    }, "\nSession log: child-session.jsonl", "\nHint: local:// is parent-scoped");

    expect(text).toBe(
      "Agent failed: provider unavailable\nSession log: child-session.jsonl\n\n" +
      "Agent failed before producing a final answer.\n\n" +
      "Error: provider unavailable\n\n" +
      "Tool uses before exit: 3\n\n" +
      "Transcript file: /tmp/agent-output.jsonl" +
      "\nHint: local:// is parent-scoped",
    );
    expect(text).not.toContain("Partial output before the failure");
  });

  it("keeps terminal states concise when collapsed", () => {
    const completed = textOf(renderAgentToolResult(result("final answer\nmore detail", { ...runningDetails, status: "completed", activity: undefined, durationMs: 1500 }), {}, theme));
    const errored = textOf(renderAgentToolResult(result("failed", { ...runningDetails, status: "error", error: "boom\nstack", activity: undefined }), {}, theme));
    const queued = textOf(renderAgentToolResult(result("queued", { ...runningDetails, status: "queued", activity: undefined, agentId: "agent-456", toolUses: 0, tokens: "", durationMs: 0, turnCount: undefined, tags: undefined }), {}, theme));

    expect(completed.split("\n")[0]).toBe("├─ status: completed");
    expect(completed).toContain("├─ result: final answer");
    expect(errored.split("\n")[0]).toBe("├─ status: error");
    expect(errored).toContain("├─ error: boom");
    expect(queued.split("\n")[0]).toBe("├─ status: queued");
    expect(queued).toContain("├─ agent: agent-456");
    expect(queued).not.toContain("tools: 0");
    expect(queued).not.toContain("duration: 0.0s");
  });
});

describe("get_subagent_result TUI rendering", () => {
  const raw = [
    "Agent: 3c4931f8-2510-480",
    "Type: Guangguang 光光 | Status: steered | Tool uses: 0 | 35.9k | Duration: 3.3s",
    "Description: Renderer smoke check",
    "Output file: /tmp/out",
    "Session dir: /tmp/session-dir",
    "Session file: /tmp/session.jsonl",
    "",
    "renderer smoke ok",
  ].join("\n");

  function toolResult(text: string) {
    return { content: [{ type: "text" as const, text }], details: undefined };
  }

  it("renders call header with compact target", () => {
    const rendered = textOf(renderGetSubagentResultCall({ agent_id: "3c4931f8-2510-480", wait: true }, theme));

    expect(rendered).toBe("▸ get_subagent_result · 3c4931f8-2510-480 · wait");
  });

  it("collapses terminal raw result into keyword summary", () => {
    const rendered = textOf(renderGetSubagentResult(toolResult(raw), { expanded: false }, theme));

    expect(rendered).toContain("├─ status: completed (turn limit)");
    expect(rendered).toContain("├─ agent: Guangguang 光光");
    expect(rendered).toContain("├─ context: 35.9k");
    expect(rendered).toContain("├─ duration: 3.3s");
    expect(rendered).toContain("├─ result: renderer smoke ok");
    expect(rendered).toContain("└─ app.tools.expand to expand full result");
    expect(rendered).not.toContain("tools: 0");
    expect(rendered).not.toContain("tools: context");
    expect(rendered).not.toContain("Agent: 3c4931f8-2510-480");
    expect(rendered).not.toContain("Description: Renderer smoke check");
  });

  it("collapses running poll into activity plus next action", () => {
    const running = [
      "Agent: agent-789",
      "Type: Jintong 金童 | Status: running | Turns: 2 | Tool uses: 0 | Duration: 0.0s (running)",
      "Description: Renderer poll",
      "",
      "Turns: 2",
      "Max turns: unlimited",
      "Current activity: editing renderer tests",
      "",
      "Agent is still running. Use wait: true or check back later.",
    ].join("\n");
    const rendered = textOf(renderGetSubagentResult(toolResult(running), { expanded: false }, theme));

    expect(rendered).toContain("├─ status: running");
    expect(rendered).toContain("├─ activity: editing renderer tests");
    expect(rendered).toContain("├─ agent: Jintong 金童");
    expect(rendered).toContain("├─ turns: 2");
    expect(rendered).toContain("├─ next: wait true or check back later");
    expect(rendered).not.toContain("result: Agent is still running");
    expect(rendered).not.toContain("tools: 0");
    expect(rendered).not.toContain("duration: 0.0s");
  });

  it("keeps expanded get_subagent_result raw content exact", () => {
    const rendered = textOf(renderGetSubagentResult(toolResult(raw), { expanded: true }, theme));

    expect(rendered).toBe(raw);
  });
});
