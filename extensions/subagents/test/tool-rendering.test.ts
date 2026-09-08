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
  it("preserves Agent description and skills call preview and width safety", () => {
    const call = requireTool("Agent").renderCall({
      subagent_type: "Explore", description: "Review 界面 boundary fix",
      skills: ["codebase-design", "typescript-best-practices", "react-best-practices", "diagnosing-bugs"],
    }, theme);
    expect(rawText(call)).toBe("▸ Agent · Review 界面 boundary fix · skills: 4 · codebase-design, typescript-best-practices, react-best-practices, diagnosing-bugs");
    expectWidthSafe(call);
  });

  it("preserves get_subagent_result ID and wait call preview and width safety", () => {
    const call = requireTool("get_subagent_result").renderCall({ agent_id: "d398d6ea-cbc8-4d8", wait: true }, theme);
    expect(rawText(call)).toBe("▸ get_subagent_result · d398d6ea-cbc8-4d8 · wait");
    expectWidthSafe(call);
  });
  const answer = "**Decisive answer**\n\n- 界面 🚀 é\n\n```ts\nconst complete = true;\n```\n\n" + "Complete retained line.\n".repeat(60);
  const base: AgentDetails = {
    displayName: "Explore", description: "Review", subagentType: "Explore",
    status: "completed", result: answer, modelName: "provider/model", thinking: "off",
    turnCount: 2, maxTurns: 1, toolUses: 0, tokens: "488.9k token", durationMs: 12000,
    outputFile: "/tmp/完整路径/agent.output", agentId: "actual-id",
    diagnostics: ["extension-error:exclude_extensions has no effect"],
    conversation: "[User]: full verbose conversation",
  };

  it.each(["Agent", "get_subagent_result"])("B02 %s renders compact report and complete expanded result", (name) => {
    const tool = requireTool(name);
    const result: ToolResult = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: "Agent ID: actual-id\nMODEL-FACING ENVELOPE" }]),
      details: Object.freeze(base), isError: false,
    });
    const collapsed = tool.renderResult(result, { expanded: false }, theme);
    const expanded = tool.renderResult(result, { expanded: true }, theme);
    const compact = renderText(collapsed, 240);
    expect(compact).toContain("Decisive answer");
    expect(compact).not.toContain("result: Agent ID");
    expect(compact).toContain("model: provider/model · thinking: off");
    expect(compact).toContain("turns: 2 · soft limit: 1");
    expect(compact).toContain("tokens: 488.9k");
    expect(compact).not.toContain("context:");
    expect(compact).not.toContain("tools: 0");
    expect(compact).toContain("to expand full result");
    const full = renderText(expanded);
    expect(full.indexOf("Decisive answer")).toBeLessThan(full.indexOf("Run"));
    expect(full).toContain("const complete = true;");
    expect(full.match(/Complete retained line\./g)).toHaveLength(60);
    expect(full).toContain("tools: 0");
    expect(full).toContain("Artifacts");
    expect(full).toContain(base.outputFile);
    expect(full).toContain("exclude_extensions has no effect");
    expect(full).toContain("full verbose conversation");
    for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
      expect(collapsed.render(width).length).toBeLessThanOrEqual(3);
      for (const component of [collapsed, expanded]) for (const line of component.render(width)) {
        expect(visibleWidth(line), `${JSON.stringify(line)} at ${width}`).toBeLessThanOrEqual(width);
        expect(line).not.toContain("�");
      }
    }
    expect(result.content[0]?.text).toBe("Agent ID: actual-id\nMODEL-FACING ENVELOPE");
    expect(result.isError).toBe(false);
  });

  it.each(["queued", "running", "steered", "stopped", "aborted", "error"] as const)("B02 truthful %s transition", (status) => {
    const result = { content: [{ type: "text" as const, text: "envelope" }], details: {
      ...base, status, activity: "reading 界面", error: status === "error" ? "Decisive failure" : undefined,
    } };
    const tool = requireTool("Agent");
    const compact = renderText(tool.renderResult(result, { expanded: false }, theme), 240);
    const full = renderText(tool.renderResult(result, { expanded: true }, theme));
    const decisive = status === "error" ? "Decisive failure" : status === "running" ? "reading 界面" : status === "queued" ? "waiting for a slot" : "Decisive answer";
    expect(compact).toContain(decisive);
    expect(full).toContain(decisive);
  });

  it.each(["Agent", "get_subagent_result"])("B03 %s shows exact denial and preserves legacy/malformed raw fallback", (name) => {
    const tool = requireTool(name);
    const reason = "Delegation denied: only Explore is permitted.";
    const denied = Object.freeze({ content: [{ type: "text" as const, text: reason }], isError: true, details: {
      ...base, status: "error" as const, category: "delegation_policy_denied" as const, result: "", error: reason,
    } });
    for (const expanded of [false, true]) {
      expect(renderText(tool.renderResult(denied, { expanded }, theme))).toContain(reason);
    }
    for (const details of [undefined, "broken", { ...base, result: undefined }, { ...base, tags: 42 }, { ...base, error: {} }]) {
      const raw = "Agent: legacy\n\n**Entire original body**\n" + "retained\n".repeat(60);
      const result = { content: [{ type: "text" as const, text: raw }], details };
      expect(rawText(tool.renderResult(result, { expanded: true }, theme))).toBe(raw);
      const collapsed = tool.renderResult(result, { expanded: false }, theme);
      expect(renderText(collapsed)).toContain("Agent: legacy");
      expect(renderText(collapsed)).toContain("to expand full result");
      for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
        const lines = collapsed.render(width);
        expect(lines.length).toBeLessThanOrEqual(3);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(denied.content[0]?.text).toBe(reason);
    expect(denied.isError).toBe(true);
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
