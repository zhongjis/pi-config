import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AgentPresentation, createNotificationCoordinator } from "../src/notification-coordinator.js";
import type { AgentRecord, NotificationDetails } from "../src/types.js";

vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));
// Stub keyHint so graph-run-card renders (used by G2 tests) do not need a real TUI theme.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, keyHint: (_key: string, label?: string) => label ?? "" };
});

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { graphRunEntryData } from "../src/graph/entry.js";
import { createGraphRunTask } from "../src/graph/task.js";
import subagentsExtension from "../src/index.js";

type Renderable = {
  render(width: number): string[];
};

type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};

type MessageRenderer = (
  message: { content?: unknown; details?: NotificationDetails },
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

const theme = {
  fg: vi.fn((_color: string, text: string) => text),
  bg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
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

function renderCard(message: { content?: unknown; details?: NotificationDetails }, expanded = false, width = 120): string[] {
  const component = requireRenderer()(message, { expanded }, theme);
  expect(component).toBeDefined();
  return component?.render(width) ?? [];
}

function notificationContent(lines: string[]): string[] {
  return lines.slice(3, -1).map(line => (line.startsWith(" ") ? line.slice(1) : line).trimEnd());
}

function render(details: NotificationDetails, expanded = false, width = 120): string[] {
  return notificationContent(renderCard({ details }, expanded, width));
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
  theme.fg.mockClear();
  theme.bg.mockClear();
  theme.bold.mockClear();
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
      "Found the gap. Additional detail.",
      "  transcript: /tmp/subagents/agent-1.output",
    ]);
  });

  it("uses the custom-message card shell and theme tokens", () => {
    expect(renderCard({ details: notification() }).map(line => line.trim())).toEqual([
      "",
      "[notification]",
      "",
      "✓ Renderer migration · ↻4≤12 · 3 tools · 12.3k · 1m5s",
      "Found the gap. Additional detail.",
      "transcript: /tmp/subagents/agent-1.output",
      "",
    ]);
    expect(theme.fg).toHaveBeenCalledWith("customMessageLabel", "[notification]");
    expect(theme.fg).toHaveBeenCalledWith("customMessageText", "✓ Renderer migration · ↻4≤12 · 3 tools · 12.3k · 1m5s");
    expect(theme.bg).toHaveBeenCalledWith("customMessageBg", expect.any(String));
  });

  it("renders standalone completion previews and expanded transcript rows without tree connectors", () => {
    const details = notification({
      resultPreview: "First finding.\nSecond finding.",
      outputFile: "/tmp/subagents/complete-output.txt",
    });
    const collapsedCard = renderCard({ details }, false);
    const collapsed = notificationContent(collapsedCard).map(stripTerminalSequences);
    const expanded = notificationContent(renderCard({ details }, true)).map(stripTerminalSequences);

    expect(collapsedCard.map(line => stripTerminalSequences(line).trim())).toContain("[notification]");
    expect(collapsed).toContain("First finding. Second finding.");
    expect(expanded).toEqual([
      "✓ Renderer migration · ↻4≤12 · 3 tools · 12.3k · 1m5s",
      "  First finding.",
      "  Second finding.",
      "  transcript: /tmp/subagents/complete-output.txt",
    ]);
    for (const line of [...collapsed, ...expanded]) expect(line.trimStart()).not.toMatch(/^[├└]─/);
  });

  it.each([
    ["pretty object", JSON.stringify({ status: "ok", count: 2 }, null, 2), '{ "status": "ok", "count": 2 }'],
    ["pretty array", JSON.stringify(["alpha", "beta"], null, 2), '[ "alpha", "beta" ]'],
    ["multiline prose", "First finding.\n  Second finding.", "First finding. Second finding."],
    ["truncated JSON", '{\n  "status": "ok",\n  "items": [\n    "partial…', '{ "status": "ok", "items": [ "partial…'],
  ])("flattens %s only in the collapsed notification", (_label, resultPreview, expected) => {
    const message = Object.freeze({
      content: resultPreview,
      details: Object.freeze(notification({ resultPreview, outputFile: undefined })),
    });
    const before = JSON.stringify(message);
    const collapsed = notificationContent(renderCard(message, false)).slice(1).map(line => line.trim());
    expect(collapsed).toEqual([expected]);
    const expanded = notificationContent(renderCard(message, true)).slice(1);
    expect(expanded).toEqual(resultPreview.split("\n").map((line) => `  ${line}`));
    expect(JSON.stringify(message)).toBe(before);
  });

  it("normalizes surrounding whitespace and CRLF without inventing blank output", () => {
    expect(render(notification({ resultPreview: "\n  First.\r\n\tSecond.  " }))[1]).toBe("First. Second.");
    expect(render(notification({ resultPreview: " \n\t\r\n ", outputFile: undefined }))).toHaveLength(1);
  });

  it("marks only clipped previews with an ellipsis and retains expanded text", () => {
    const resultPreview = `${"x".repeat(100)}\nretained ending`;
    const details = notification({ resultPreview, outputFile: undefined });
    expect(stripTerminalSequences(render(details)[1]).trim()).toMatch(/^x+…$/);
    expect(render(details, true).slice(1)).toEqual([`  ${"x".repeat(100)}`, "  retained ending"]);
    expect(stripTerminalSequences(render(notification({ resultPreview: "x".repeat(80) }))[1]).trim()).toMatch(/^x+$/);
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
    expect(lines).toContain("one");
    expect(lines).toContain("two");
    expect(lines).toContain("three");
    expect(lines.join("\n")).not.toMatch(/^[├└]─/m);
  });

  it("preserves complete expanded output beyond preview budgets", () => {
    const resultPreview = Array.from(
      { length: 31 },
      (_, index) => `result line ${index + 1} ${"x".repeat(140)}`,
    ).join("\n");
    const details = Object.freeze(notification({ resultPreview, outputFile: undefined }));
    const before = JSON.stringify(details);
    const lines = render(details, true, 5_000);

    expect(resultPreview.length).toBeGreaterThan(4_000);
    expect(lines.slice(1)).toEqual(resultPreview.split("\n").map(line => `  ${line}`));
    expect(JSON.stringify(details)).toBe(before);
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

    for (const width of [0, ...Array.from({ length: 12 }, (_, index) => index + 1), 20, 40, 80, 120]) {
      for (const line of render(details, true, width)) {
        expect(visibleWidth(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it.each([
    ["a transcript", "/tmp/subagents/full-output.txt", 501],
    ["result retrieval", undefined, 502],
  ])("discloses %s for omitted notification result characters", (_route, outputFile, resultLength) => {
    vi.useFakeTimers();
    const result = "界".repeat(resultLength);
    const record: AgentRecord = {
      id: "agent-full-output",
      type: "general-purpose",
      description: "Full output route",
      status: "completed",
      result,
      toolUses: 0,
      startedAt: 0,
      completedAt: 1,
      outputFile,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const notificationPi = { sendMessage: vi.fn() };
    const coordinator = createNotificationCoordinator(
      notificationPi as unknown as ExtensionAPI,
      () => record,
      {
        activity: new Map(),
        widget: { markFinished: vi.fn(), update: vi.fn() },
        fleet: { onAgentFinished: vi.fn() },
      } as unknown as AgentPresentation,
    );

    coordinator.onComplete(record);
    vi.advanceTimersByTime(200);

    const message = notificationPi.sendMessage.mock.calls[0]?.[0] as SentMessage;
    const omitted = result.length - 500;
    const route = outputFile ? "transcript below" : `get_subagent_result(agent_id: "${record.id}")`;
    const marker = `… ${omitted} character${omitted === 1 ? "" : "s"} omitted · full output: ${route}`;
    expect(message.details.resultPreview).toBe(`${result.slice(0, 500)}\n${marker}`);
    expect(message.content).toContain("...(truncated, use get_subagent_result for full output)");
    expect(message.content).not.toContain(marker);

    const expanded = notificationContent(renderCard({ details: message.details }, true, 5_000)).join("\n");
    expect(expanded).toContain(marker);
    if (outputFile) expect(expanded).toContain(`transcript: ${outputFile}`);
    expect(notificationContent(renderCard({ details: message.details }, false, 5_000)).join("\n")).not.toContain("full output:");
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

  it("renders workflow card for valid workflow entry in notification (G2 valid)", () => {
    const task = createGraphRunTask({ id: "agr_note", script: "" });
    task.status = "completed";
    task.value = "answer";
    task.graphRunName = "notify-demo";
    const wf = graphRunEntryData(task);
    const card = renderCard({ details: notification({ graphRun: wf }) }, false, 120).map(line => line.trim());
    const output = card.join("\n");
    expect(card[1]).toBe("[notification]");
    expect(output).toContain("notify-demo");
    expect(output).not.toContain("Renderer migration");
    expect(theme.fg).toHaveBeenCalledWith("customMessageText", expect.any(String));
    expect(theme.bg).toHaveBeenCalledWith("customMessageBg", expect.any(String));
  });

  it("falls back to raw content for invalid workflow entry in notification (G2 invalid)", () => {
    const renderer = requireRenderer();
    const result = renderer(
      { details: notification({ graphRun: { not: "valid" } as unknown as NotificationDetails["graphRun"] }), content: "raw-graph-text" } as Parameters<typeof renderer>[0],
      { expanded: false },
      theme,
    );
    expect(result?.render(120).join("\n")).toContain("raw-graph-text");
  });

  it("keeps malformed workflow fallback previews and expand hints flat", () => {
    const renderer = requireRenderer();
    const result = renderer(
      { details: notification({ graphRun: { not: "valid" } as unknown as NotificationDetails["graphRun"] }), content: "raw-graph-text" } as Parameters<typeof renderer>[0],
      { expanded: false },
      theme,
    );
    const lines = notificationContent(result?.render(120) ?? []).map(stripTerminalSequences);

    expect(lines).toContain("raw-graph-text");
    expect(lines).toContain("to expand full result");
    for (const line of lines) expect(line.trimStart()).not.toMatch(/^[├└]─/);
  });
});
