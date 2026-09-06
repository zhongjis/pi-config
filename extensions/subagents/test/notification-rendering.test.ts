import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NotificationDetails } from "../src/types.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

type Renderable = {
  render(width: number): string[];
};

type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type MessageRenderer = (
  message: { details?: NotificationDetails },
  options: { expanded: boolean },
  theme: Theme,
) => Renderable | undefined;

type ToolDefinition = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
};

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

type SentMessage = {
  customType: string;
  content: string;
  display: boolean;
  details: NotificationDetails;
};

const theme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const renderers = new Map<string, MessageRenderer>();
const tools = new Map<string, ToolDefinition>();
const lifecycle = new Map<string, LifecycleHandler>();
const sendMessage = vi.fn();
const pi = {
  registerMessageRenderer: vi.fn((type: string, renderer: MessageRenderer) => renderers.set(type, renderer)),
  registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
  registerCommand: vi.fn(),
  registerFlag: vi.fn(),
  on: vi.fn((event: string, handler: LifecycleHandler) => lifecycle.set(event, handler)),
  events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
  appendEntry: vi.fn(),
  sendMessage,
};

let tmpDir: string;
let agentDir: string;
let previousCwd: string;
let previousAgentDir: string | undefined;

function notification(overrides: Partial<NotificationDetails> = {}): NotificationDetails {
  return {
    id: "agent-1",
    description: "Renderer migration",
    status: "completed",
    toolUses: 3,
    turnCount: 4,
    maxTurns: 12,
    totalTokens: 12_345,
    durationMs: 65_000,
    outputFile: "/tmp/subagents/agent-1.output",
    resultPreview: "Found the gap.\nAdditional detail.",
    ...overrides,
  };
}

function requireRenderer(): MessageRenderer {
  const renderer = renderers.get("subagent-notification");
  expect(renderer).toBeTypeOf("function");
  return renderer as MessageRenderer;
}

function render(details: NotificationDetails, expanded = false, width = 120): string[] {
  const component = requireRenderer()({ details }, { expanded }, theme);
  expect(component).toBeDefined();
  return component?.render(width) ?? [];
}

function extensionContext(): ExtensionContext {
  return {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
    },
    cwd: tmpDir,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "notification-session", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as unknown as ExtensionContext;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-notification-rendering-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-notification-agentdir-"));
  previousCwd = process.cwd();
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  writeFileSync(
    join(tmpDir, ".pi", "subagents.json"),
    JSON.stringify({ defaultJoinMode: "async", outputTranscript: false }),
  );
  process.chdir(tmpDir);
  subagentsExtension(pi as unknown as ExtensionAPI);
});

afterEach(() => {
  vi.useRealTimers();
  sendMessage.mockClear();
});

afterAll(async () => {
  await lifecycle.get("session_shutdown")?.({}, extensionContext());
  process.chdir(previousCwd);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("subagent notification rendering migration", () => {
  it("renders a completed individual summary with stats, result, and transcript", () => {
    expect(render(notification())).toEqual([
      "✓ Renderer migration · ↻4≤12 · 3 tools · 12.3k · 1m5s",
      "└─ Found the gap.",
      "  transcript: /tmp/subagents/agent-1.output",
    ]);
  });

  it("renders grouped details in others order with one summary per agent", () => {
    const details = notification({
      description: "First",
      resultPreview: "one",
      others: [
        notification({ id: "agent-2", description: "Second", resultPreview: "two", outputFile: undefined }),
        notification({ id: "agent-3", description: "Third", resultPreview: "three", outputFile: undefined }),
      ],
    });

    const lines = render(details);
    expect(lines.filter((line) => /^[✓■✗] /.test(line))).toHaveLength(3);
    expect(lines.indexOf("✓ First · ↻4≤12 · 3 tools · 12.3k · 1m5s")).toBeLessThan(lines.indexOf("✓ Second · ↻4≤12 · 3 tools · 12.3k · 1m5s"));
    expect(lines.indexOf("✓ Second · ↻4≤12 · 3 tools · 12.3k · 1m5s")).toBeLessThan(lines.indexOf("✓ Third · ↻4≤12 · 3 tools · 12.3k · 1m5s"));
    expect(lines).toContain("└─ one");
    expect(lines).toContain("└─ two");
    expect(lines).toContain("└─ three");
  });

  it("retains only the current expanded result preview line limit", () => {
    const resultPreview = Array.from({ length: 31 }, (_, index) => `result line ${index + 1}`).join("\n");
    const lines = render(notification({ resultPreview, outputFile: undefined }), true);

    expect(lines).toContain("  result line 1");
    expect(lines).toContain("  result line 30");
    expect(lines).not.toContain("  result line 31");
  });

  it.each([
    ["steered", "✓ Steered · turn limit"],
    ["stopped", "■ Stopped · stopped"],
    ["aborted", "✗ Aborted · aborted"],
    ["error", "✗ Error · error: process exited 1"],
    ["future-status", "✓ Future"],
  ])("renders %s readably", (status, expected) => {
    const description = expected.split(" ")[1] ?? "Status";
    const lines = render(notification({
      description,
      status,
      error: status === "error" ? "process exited 1\nstack omitted" : undefined,
      resultPreview: "",
      outputFile: undefined,
      toolUses: 0,
      turnCount: 0,
      totalTokens: 0,
      durationMs: 0,
    }));
    expect(lines[0]).toBe(expected);
  });

  it("returns undefined for missing or malformed details so Pi can use raw fallback", () => {
    const renderer = requireRenderer();
    expect(renderer({}, { expanded: false }, theme)).toBeUndefined();
    expect(renderer(
      { details: { description: 42 } as unknown as NotificationDetails },
      { expanded: false },
      theme,
    )).toBeUndefined();
    expect(renderer(
      { details: notification({ others: [{} as NotificationDetails] }) },
      { expanded: false },
      theme,
    )).toBeUndefined();
  });

  it("does not mutate frozen notification details", () => {
    const other = Object.freeze(notification({ id: "agent-2", description: "Frozen other" }));
    const details = Object.freeze(notification({ others: Object.freeze([other]) as unknown as NotificationDetails[] }));
    const before = JSON.stringify(details);

    render(details, true, 40);

    expect(JSON.stringify(details)).toBe(before);
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(other)).toBe(true);
  });

  it("is width-safe for ANSI and CJK content at the required width matrix", () => {
    const details = notification({
      description: "\u001b[35m金童\u001b[0m 修复🧪 e\u0301 " + "界".repeat(80),
      resultPreview: "\u001b[31m结果🧩 e\u0301\u001b[0m " + "界".repeat(100),
      outputFile: "/tmp/" + "长".repeat(80),
    });

    for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
      for (const line of render(details, true, width)) {
        expect(visibleWidth(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps individual sendMessage payload, options, and 200ms hold unchanged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
    const session = { dispose: vi.fn(), subscribe: vi.fn(() => vi.fn()) } as unknown as AgentSession;
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "Renderer migration complete.",
      session,
      aborted: false,
      steered: false,
    });
    const tool = tools.get("Agent");
    expect(tool).toBeDefined();

    await tool?.execute(
      "delivery-call",
      {
        prompt: "verify delivery",
        description: "Delivery regression",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      extensionContext(),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(199);
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const [message, options] = sendMessage.mock.calls[0] as unknown as [SentMessage, Record<string, unknown>];
    const id = message.details.id;
    expect(message).toEqual({
      customType: "subagent-notification",
      content: [
        "<task-notification>",
        `<task-id>${id}</task-id>`,
        "<tool-use-id>delivery-call</tool-use-id>",
        "<status>Done</status>",
        '<summary>Agent "Delivery regression" completed</summary>',
        "<result>Renderer migration complete.</result>",
        "<usage><total_tokens>0</total_tokens><tool_uses>0</tool_uses><duration_ms>0</duration_ms></usage>",
        "</task-notification>",
      ].join("\n"),
      display: true,
      details: {
        id,
        description: "Delivery regression",
        status: "completed",
        toolUses: 0,
        turnCount: 0,
        maxTurns: undefined,
        totalTokens: 0,
        durationMs: 0,
        outputFile: undefined,
        error: undefined,
        resultPreview: "Renderer migration complete.",
      },
    });
    expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });
});
