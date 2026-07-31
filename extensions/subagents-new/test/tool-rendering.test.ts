import { fileURLToPath } from "node:url";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import type { AgentDetails } from "../src/ui/agent-widget.js";

type ToolResult = {
  content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  details?: unknown;
  isError?: boolean;
};

type Renderable = {
  render(width: number): string[];
  text?: string;
};

type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type ToolDefinition = {
  name: string;
  renderCall?: (args: Record<string, unknown>, theme: Theme, context?: unknown) => Renderable;
  renderResult?: (
    result: ToolResult,
    options: { expanded?: boolean; isPartial?: boolean },
    theme: Theme,
    context?: { args?: Record<string, unknown> },
  ) => Renderable;
};

const theme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const tools = new Map<string, ToolDefinition>();
const lifecycle = new Map<string, (...args: unknown[]) => unknown>();

function renderText(component: Renderable, width = 120): string {
  return component.render(width).join("\n");
}

function rawText(component: Renderable): string {
  return component.text ?? renderText(component);
}

function expectWidthSafe(component: Renderable): void {
  for (const width of [8, 20, 40, 80, 120]) {
    for (const line of component.render(width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
}

function requireTool(name: string): Required<Pick<ToolDefinition, "renderCall" | "renderResult">> & ToolDefinition {
  const tool = tools.get(name);
  expect(tool, `${name} registered`).toBeDefined();
  expect(tool?.renderCall, `${name}.renderCall`).toBeTypeOf("function");
  expect(tool?.renderResult, `${name}.renderResult`).toBeTypeOf("function");
  return tool as Required<Pick<ToolDefinition, "renderCall" | "renderResult">> & ToolDefinition;
}

beforeAll(() => {
  const previousPackageDir = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = fileURLToPath(
    new URL("../../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url),
  );
  try {
    initTheme(undefined, false);
  } finally {
    if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = previousPackageDir;
  }
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  subagentsExtension(pi as unknown as ExtensionAPI);
});

afterAll(async () => {
  await lifecycle.get("session_shutdown")?.();
});

describe("subagent tool rendering migration", () => {
  it("renders running Agent call and result with requested hierarchy", () => {
    const tool = requireTool("Agent");
    const args = {
      subagent_type: "Explore",
      description: "Review 界面 boundary fix",
      skills: ["codebase-design", "typescript-best-practices", "react-best-practices", "diagnosing-bugs"],
    };
    const details: AgentDetails = {
      displayName: "Explore",
      description: args.description,
      subagentType: "Explore",
      status: "running",
      activity: "thinking…",
      tags: ["thinking: high"],
      turnCount: 11,
      toolUses: 21,
      tokens: "488.9k token",
      durationMs: 12_000,
      spinnerFrame: 0,
    };
    const result: ToolResult = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: "21 tool uses..." }]),
      details: Object.freeze(details),
      isError: false,
    });

    const call = tool.renderCall(args, theme);
    const collapsed = tool.renderResult(result, { expanded: false, isPartial: true }, theme, { args });
    const text = renderText(collapsed);

    expect(rawText(call)).toBe(
      "▸ Agent · Review 界面 boundary fix · skills: 4 · codebase-design, typescript-best-practices, react-best-practices, diagnosing-bugs",
    );
    expect(text).toContain("├─ status: running");
    expect(text).toContain("├─ activity: thinking…");
    expect(text).toContain("├─ model: thinking high · ↻11");
    expect(text).toContain("├─ tools: 21");
    expect(text).toContain("├─ context: 488.9k");
    expect(text).toContain("to expand full result");
    expect(result.content[0]?.text).toBe("21 tool uses...");
    expect(result.isError).toBe(false);
    expectWidthSafe(call);
    expectWidthSafe(collapsed);
  });

  it("renders completed get_subagent_result history and preserves full expansion", () => {
    const tool = requireTool("get_subagent_result");
    const args = { agent_id: "d398d6ea-cbc8-4d8", wait: true };
    const raw = [
      "Agent: d398d6ea-cbc8-4d8",
      "Type: Cheng Feng 乘风 | Status: completed | Turns: 27 | Tool uses: 82 | 302.4k token | Context: 91% | Duration: 328.3s",
      "Description: Trace both output renderers",
      "",
      "**Answer**",
      "Renderer migration map complete.",
    ].join("\n");
    const result: ToolResult = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: raw }]),
      isError: false,
    });

    const call = tool.renderCall(args, theme);
    const collapsed = tool.renderResult(result, { expanded: false }, theme, { args });
    const expanded = tool.renderResult(result, { expanded: true }, theme, { args });
    const text = renderText(collapsed);

    expect(rawText(call)).toBe("▸ get_subagent_result · d398d6ea-cbc8-4d8 · wait");
    expect(text).toContain("├─ status: completed");
    expect(text).toContain("├─ agent: Cheng Feng 乘风");
    expect(text).toContain("├─ tools: 82");
    expect(text).toContain("├─ context: 302.4k");
    expect(text).toContain("├─ turns: 27");
    expect(text).toContain("├─ duration: 328.3s");
    expect(text).toContain("├─ result: **Answer**");
    expect(text).toContain("to expand full result");
    expect(rawText(expanded)).toBe(raw);
    expect(result.content[0]?.text).toBe(raw);
    expect(result.isError).toBe(false);
    expectWidthSafe(call);
    expectWidthSafe(collapsed);
    expectWidthSafe(expanded);
  });

  it("renders a running poll with activity and next action while omitting zero stats", () => {
    const tool = requireTool("get_subagent_result");
    const raw = [
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
    const result: ToolResult = { content: [{ type: "text", text: raw }] };
    const rendered = renderText(tool.renderResult(result, { expanded: false }, theme));

    expect(rendered).toContain("├─ status: running");
    expect(rendered).toContain("├─ activity: editing renderer tests");
    expect(rendered).toContain("├─ agent: Jintong 金童");
    expect(rendered).toContain("├─ turns: 2");
    expect(rendered).toContain("├─ next: wait true or check back later");
    expect(rendered).not.toContain("tools: 0");
    expect(rendered).not.toContain("duration: 0.0s");
    expect(rendered).not.toContain("result: Agent is still running");
  });

  it("preserves raw fallbacks and complete Agent expansion", () => {
    const agent = requireTool("Agent");
    const history = requireTool("get_subagent_result");
    const longRaw = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
    const details: AgentDetails = {
      displayName: "Explore",
      description: "Long result",
      subagentType: "Explore",
      status: "completed",
      toolUses: 1,
      tokens: "2.4k token",
      durationMs: 1500,
    };
    const agentResult: ToolResult = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: longRaw }]),
      details: Object.freeze(details),
    });
    const malformed = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: "Agent not found: missing" }]),
    });
    const malformedAgent = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: "raw Agent fallback" }]),
      details: "broken",
    });

    expect(rawText(agent.renderResult(agentResult, { expanded: true }, theme))).toBe(longRaw);
    expect(rawText(agent.renderResult(malformedAgent, { expanded: false }, theme))).toBe("raw Agent fallback");
    expect(renderText(history.renderResult(malformed, { expanded: false }, theme))).toContain(
      "error: Agent not found: missing",
    );
    expect(rawText(history.renderResult(malformed, { expanded: true }, theme))).toBe("Agent not found: missing");
    expect(agentResult.content[0]?.text).toBe(longRaw);
    expect(malformed.content[0]?.text).toBe("Agent not found: missing");
    expect(malformedAgent.content[0]?.text).toBe("raw Agent fallback");
  });

  it("renders steer_subagent call preview and delivered expansion without mutating frozen input", () => {
    const tool = requireTool("steer_subagent");
    const message = Object.freeze({
      value: `  alpha \n\t${"界".repeat(80)}  `,
    }).value;
    const args = Object.freeze({ agent_id: "agent-123", message });
    const raw = [
      "Steering message sent to agent agent-123. The agent will process it after its current tool execution.",
      "Current state: 2.4k tokens · 3 tool uses",
    ].join("\n");
    const result: ToolResult = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: raw }]),
      isError: false,
    });
    const expectedPreview = `alpha ${"界".repeat(65)}…`;

    const call = tool.renderCall(args, theme);
    const collapsed = tool.renderResult(result, { expanded: false }, theme, { args });
    const expanded = tool.renderResult(result, { expanded: true }, theme, { args });

    expect(rawText(call)).toBe(`▸ steer_subagent · agent-123 · "${expectedPreview}"`);
    expect(Array.from(expectedPreview)).toHaveLength(72);
    expect(renderText(collapsed)).toContain("├─ status: delivered");
    expect(renderText(collapsed)).not.toContain("Current state:");
    expect(rawText(expanded)).toBe(`${raw}\n\nMessage\n${message}`);
    expect(args).toEqual({ agent_id: "agent-123", message });
    expect(result.content[0]?.text).toBe(raw);
    expect(result.isError).toBe(false);
  });

  it("renders an incomplete steer_subagent call without throwing", () => {
    const tool = requireTool("steer_subagent");

    const call = tool.renderCall({}, theme);

    expect(rawText(call)).toBe("▸ steer_subagent");
    expectWidthSafe(call);
  });

  it.each([
    ["queued", "Steering message queued for agent agent-123. It will be delivered once the session initializes.", ["status: queued"]],
    ["missing-target", 'Agent not found: "missing". It may have been cleaned up.', ["status: missing-target", 'reason: Agent not found: "missing". It may have been cleaned up.']],
    ["rejected", 'Agent "agent-123" is not running (status: completed). Cannot steer a non-running agent.', ["status: rejected", 'reason: Agent "agent-123" is not running (status: completed). Cannot steer a non-running agent.']],
    ["failed", "Failed to steer agent: transport closed", ["status: failed", "error: transport closed"]],
    ["unknown/raw", "Unexpected steering response\nmore detail", ["result: Unexpected steering response"]],
    ["empty", "", ["result: no output"]],
  ])("renders %s steer_subagent terminal summary", (_name, raw, expectedRows) => {
    const tool = requireTool("steer_subagent");
    const result: ToolResult = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: raw }]),
    });

    const text = renderText(tool.renderResult(result, { expanded: false }, theme));

    for (const row of expectedRows) expect(text).toContain(row);
    expect(text.split("\n")).toHaveLength(expectedRows.length + 1);
    expect(result.content[0]?.text).toBe(raw);
  });

  it("renders steer_subagent partial status independently from terminal content", () => {
    const tool = requireTool("steer_subagent");
    const result: ToolResult = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: "Steering message sent to agent agent-123." }]),
    });

    const text = renderText(tool.renderResult(result, { expanded: false, isPartial: true }, theme));

    expect(text).toContain("├─ status: sending");
    expect(text).not.toContain("status: delivered");
    expect(text.split("\n")).toHaveLength(2);
  });

  it("keeps steer_subagent call and results width-safe for ANSI, CJK, emoji, and combining text", () => {
    const tool = requireTool("steer_subagent");
    const message = "\u001b[31m界面🚀e\u0301 guidance\u001b[0m ".repeat(12);
    const args = Object.freeze({ agent_id: "agent-界面-🚀-e\u0301", message });
    const raw = `Unexpected \u001b[32m界面🚀e\u0301\u001b[0m ${"路径".repeat(40)}`;
    const result: ToolResult = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: raw }]),
    });
    const components = [
      tool.renderCall(args, theme),
      tool.renderResult(result, { expanded: false }, theme, { args }),
      tool.renderResult(result, { expanded: true }, theme, { args }),
    ];

    for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
      for (const component of components) {
        for (const line of component.render(width)) {
          expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});
