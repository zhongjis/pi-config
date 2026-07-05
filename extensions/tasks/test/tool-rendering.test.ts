import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskRuntime } from "../src/lifecycle/store-glue.js";
import { registerTaskTools } from "../src/tools/index.js";

type RenderableText = { render?: () => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolResult = { content?: Array<{ type: "text"; text: string }>; details?: Record<string, unknown>; isError?: boolean };
type ToolDefinition = {
  name: string;
  renderCall?: (args: Record<string, unknown>, theme: PlainTheme, context?: unknown) => RenderableText;
  renderResult?: (
    result: ToolResult,
    options: { expanded?: boolean; isPartial?: boolean },
    theme: PlainTheme,
    context?: { args?: Record<string, unknown>; isError?: boolean },
  ) => RenderableText;
  execute?: (...args: any[]) => Promise<ToolResult>;
};

const plainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

function renderText(component: RenderableText): string {
  if (typeof component.render === "function") return component.render().join("\n");
  return component.text ?? "";
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function registerTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const runtime = createTaskRuntime();
  const runner = {
    getOutput: vi.fn().mockResolvedValue(""),
    stop: vi.fn().mockResolvedValue(""),
  };
  const bridge = {};
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand: vi.fn(),
  };

  registerTaskTools({ pi, runtime, runner, bridge } as never);
  return tools;
}

function collapsed(tool: ToolDefinition, raw: string, args: Record<string, unknown> = {}, extra: { isError?: boolean; isPartial?: boolean } = {}): string {
  return renderText(
    tool.renderResult!(
      { ...textResult(raw), isError: extra.isError },
      { expanded: false, isPartial: extra.isPartial },
      plainTheme,
      { args, isError: extra.isError },
    ),
  );
}

beforeEach(() => {
  process.env.PI_TASKS = "off";
});

afterEach(() => {
  delete process.env.PI_TASKS;
  vi.restoreAllMocks();
});

describe("Task tool rendering", () => {
  it("renders compact calls with full Task* names", () => {
    const tools = registerTools();

    expect(renderText(tools.get("TaskCreate")!.renderCall!({ subject: "Polish renderer", agentType: "jintong" }, plainTheme)))
      .toBe('▸ TaskCreate · "Polish renderer" · agent: jintong');
    expect(renderText(tools.get("TaskUpdate")!.renderCall!({ taskId: "7", status: "in_progress", owner: "agent" }, plainTheme)))
      .toBe("▸ TaskUpdate · #7 · status, owner");
    expect(renderText(tools.get("TaskExecute")!.renderCall!({ task_ids: ["1", "2"], model: "sonnet" }, plainTheme)))
      .toBe("▸ TaskExecute · #1, #2 · model: sonnet");
  });

  it("keeps expanded output exact and leaves model-visible content unchanged", async () => {
    const tools = registerTools();
    const tool = tools.get("TaskCreate")!;
    const result = await tool.execute!("call-1", { subject: "Keep raw", description: "Desc" }, undefined, undefined, undefined);
    const raw = result.content![0].text;

    const expanded = renderText(tool.renderResult!(result, { expanded: true }, plainTheme, { args: { subject: "Keep raw" } }));

    expect(expanded).toBe(raw);
    expect(result.content![0].text).toBe("Task #1 created successfully: Keep raw");
  });

  it("summarizes create/list/get/update results as short keyword lines", () => {
    const tools = registerTools();

    expect(collapsed(tools.get("TaskCreate")!, "Task #1 created successfully: Polish task renderer"))
      .toContain("└─ task: #1 created · Polish task renderer");

    const list = collapsed(tools.get("TaskList")!, [
      "#2 [in_progress] Implement renderer (agent)",
      "#1 [pending] Inspect output [blocked by #3]",
      "#3 [completed] Read docs",
      "#4 [pending] Verify tests",
    ].join("\n"));
    expect(list).toContain("├─ tasks: 4 total · 1 in_progress, 2 pending, 1 completed");
    expect(list).toContain("└─ tasks: #2 Implement renderer (agent), #1 Inspect output, #3 Read docs +1");
    expect(list).not.toContain("▸ TaskList");

    const get = collapsed(tools.get("TaskGet")!, [
      "Task #2: Implement renderer",
      "Status: in_progress",
      "Owner: agent-1",
      "Description: long noisy details",
      "Blocked by: #1",
      "Blocks: #4",
      "Metadata: {\"agentId\":\"agent-1\"}",
    ].join("\n"));
    expect(get).toContain("├─ task: #2 Implement renderer");
    expect(get).toContain("└─ status: in_progress · owner agent-1 · blocked by #1 · blocks #4");
    expect(get).not.toContain("Description: long noisy details");

    expect(collapsed(tools.get("TaskUpdate")!, "Updated task #2 status, owner (warning: reserved metadata keys ignored: _piWorkflowPhase)"))
      .toContain("└─ warning: reserved metadata keys ignored: _piWorkflowPhase");
  });

  it("summarizes output/stop/execute results without dumping logs", () => {
    const tools = registerTools();

    const output = collapsed(tools.get("TaskOutput")!, "Task #9 (completed) exit code: 0\n\nfirst output line\nsecond output line");
    expect(output).toContain("├─ status: completed · exit code 0");
    expect(output).toContain("└─ output: first output line");
    expect(output).not.toContain("second output line");

    const subagent = collapsed(tools.get("TaskOutput")!, "Task #3 [completed] — subagent agent-123\n\nFinal answer line\nmore detail");
    expect(subagent).toContain("├─ status: completed · subagent agent-123");
    expect(subagent).toContain("└─ result: Final answer line");

    expect(collapsed(tools.get("TaskStop")!, "Task #3 stopped successfully"))
      .toContain("└─ task: #3 stopped");

    const execute = collapsed(tools.get("TaskExecute")!, [
      "Launched 2 agent(s):",
      "#1 → agent agent-a",
      "#2 → agent agent-b",
      "Use TaskOutput to check progress. Do not spawn additional agents for these tasks.",
      "",
      "Skipped:",
      "#3: not pending (status: completed)",
    ].join("\n"));
    expect(execute).toContain("├─ agents: 2 launched");
    expect(execute).toContain("├─ tasks: #1 → agent agent-a, #2 → agent agent-b");
    expect(execute).toContain("└─ skipped: #3: not pending (status: completed)");
    expect(execute).not.toContain("Do not spawn additional agents");
  });

  it("renders partial and error states safely", () => {
    const tools = registerTools();
    const partial = renderText(tools.get("TaskOutput")!.renderResult!(textResult(""), { expanded: false, isPartial: true }, plainTheme, {}));
    expect(partial).toContain("└─ status: running TaskOutput");

    const error = collapsed(tools.get("TaskStop")!, "No running background process for task 9\nstack hidden", {}, { isError: true });
    expect(error).toContain("└─ error: No running background process for task 9");
  });
});
