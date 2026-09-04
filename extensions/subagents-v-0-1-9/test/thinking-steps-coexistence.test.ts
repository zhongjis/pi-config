import { resolve } from "node:path";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../thinking-steps/internal-patch.js", () => ({
  retainThinkingStepsPatch: vi.fn(),
}));

import thinkingStepsExtension from "../../thinking-steps/index.js";
import subagentsExtension from "../src/index.js";

type Renderable = {
  render(width: number): string[];
};

type ToolDefinition = {
  name: string;
  renderCall?: (...args: unknown[]) => unknown;
  renderResult?: (...args: unknown[]) => unknown;
};

type MessageRenderer = (...args: unknown[]) => unknown;
type LifecycleHandler = (...args: unknown[]) => unknown;

function isRenderable(value: unknown): value is Renderable {
  return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

function makePi() {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, unknown>();
  const shortcuts = new Map<string, unknown>();
  const renderers = new Map<string, MessageRenderer>();
  const lifecycle = new Map<string, LifecycleHandler[]>();

  const pi = {
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, definition: unknown) => commands.set(name, definition)),
    registerShortcut: vi.fn((key: string, definition: unknown) => shortcuts.set(key, definition)),
    registerFlag: vi.fn(),
    registerMessageRenderer: vi.fn((type: string, renderer: MessageRenderer) => renderers.set(type, renderer)),
    on: vi.fn((event: string, handler: LifecycleHandler) => {
      const handlers = lifecycle.get(event) ?? [];
      handlers.push(handler);
      lifecycle.set(event, handlers);
    }),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    tools,
    commands,
    shortcuts,
    renderers,
    lifecycle,
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("subagents + thinking-steps presentation coexistence", () => {
  it("keeps all subagent renderers registered beside Thinking Steps controls and lifecycle", async () => {
    const previousPackageDir = process.env.PI_PACKAGE_DIR;
    process.env.PI_PACKAGE_DIR = resolve(__dirname, "../../../node_modules/@earendil-works/pi-coding-agent");
    try {
      initTheme(undefined, false);
    } finally {
      if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = previousPackageDir;
    }
    const registry = makePi();
    subagentsExtension(registry.pi);

    const subagentTools = ["Agent", "get_subagent_result", "steer_subagent"].map((name) => {
      const tool = registry.tools.get(name);
      expect(tool, `${name} registered`).toBeDefined();
      expect(tool?.renderCall, `${name}.renderCall`).toBeTypeOf("function");
      expect(tool?.renderResult, `${name}.renderResult`).toBeTypeOf("function");
      return tool;
    });
    const notificationRenderer = registry.renderers.get("subagent-notification");
    expect(notificationRenderer).toBeTypeOf("function");

    thinkingStepsExtension(registry.pi);

    expect(registry.commands.has("agents")).toBe(true);
    expect(registry.commands.has("thinking-steps")).toBe(true);
    expect(registry.shortcuts.has("alt+t")).toBe(true);
    expect(registry.lifecycle.get("session_start")).toHaveLength(2);
    expect(registry.lifecycle.get("session_shutdown")).toHaveLength(2);
    for (const event of ["message_start", "message_update", "message_end", "agent_end"]) {
      expect(registry.lifecycle.get(event)?.length, `${event} handler registered`).toBeGreaterThan(0);
    }

    expect(
      ["Agent", "get_subagent_result", "steer_subagent"].map((name) => registry.tools.get(name)),
    ).toEqual(subagentTools);
    expect(registry.renderers.get("subagent-notification")).toBe(notificationRenderer);

    const agentTool = registry.tools.get("Agent");
    const raw = "Coexistence renderer result.";
    const result = {
      content: [{ type: "text" as const, text: raw }],
      details: {
        displayName: "Agent",
        description: "coexistence probe",
        subagentType: "general-purpose",
        toolUses: 1,
        tokens: "42 tokens",
        durationMs: 125,
        status: "completed",
      },
    };
    const collapsed = agentTool?.renderResult?.(result, { expanded: false, isPartial: false }, theme, {
      args: {},
    });
    const expanded = agentTool?.renderResult?.(result, { expanded: true, isPartial: false }, theme, {
      args: {},
    });
    expect(isRenderable(collapsed)).toBe(true);
    expect(isRenderable(expanded)).toBe(true);
    if (!isRenderable(collapsed) || !isRenderable(expanded)) throw new Error("Agent renderer returned no component");
    expect(collapsed.render(120).join("\n")).toContain("status: completed");
    expect(expanded.render(120).join("\n").trimEnd()).toBe(raw);

    await registry.lifecycle.get("session_shutdown")?.[0]?.();
  });
});
