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
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand: vi.fn(),
  };

  registerTaskTools({ pi, runtime, runner } as never);
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

    expect(renderText(tools.get("TaskCreate")!.renderCall!({ subject: "Polish renderer" }, plainTheme)))
      .toBe('▸ TaskCreate · "Polish renderer"');
    expect(renderText(tools.get("TaskUpdate")!.renderCall!({ taskId: "7", status: "in_progress", owner: "worker" }, plainTheme)))
      .toBe("▸ TaskUpdate · #7 · status, owner");
  });

  it("keeps expanded output exact and leaves model-visible content unchanged", async () => {
    const tools = registerTools();
    const create = tools.get("TaskCreate")!;
    const list = tools.get("TaskList")!;
    const createResult = await create.execute!("call-1", { subject: "Keep raw", description: "Desc" }, undefined, undefined, undefined);
    await create.execute!("call-2", { subject: "List raw", description: "Desc" }, undefined, undefined, undefined);
    const listResult = await list.execute!("call-3", {}, undefined, undefined, undefined);
    const raw = listResult.content![0].text;

    const expanded = renderText(list.renderResult!(listResult, { expanded: true }, plainTheme, {}));

    expect(expanded).toBe(raw);
    expect(createResult.content![0].text).toBe("Task #1 created successfully: Keep raw");
    expect(raw).toBe([
      "Ready",
      "#1 [pending] Keep raw",
      "#2 [pending] List raw",
    ].join("\n"));
  });

  it("summarizes create/list/get/update results as short keyword lines", () => {
    const tools = registerTools();

    expect(collapsed(tools.get("TaskCreate")!, "Task #1 created successfully: Polish task renderer"))
      .toContain("└─ task: #1 created · Polish task renderer");

    const list = collapsed(tools.get("TaskList")!, [
      "Running",
      "#2 [in_progress] Implement renderer (agent)",
      "Ready",
      "#4 [pending] Verify tests",
      "Blocked",
      "#1 [pending] Inspect output [blocked by #3]",
      "Completed",
      "#3 [completed] Read docs",
    ].join("\n"));
    expect(list).toContain("├─ tasks: 4 total · 1 running, 1 ready, 1 blocked, 1 completed");
    expect(list).toContain("├─ ready: #4 Verify tests");
    expect(list).toContain("├─ running: #2 Implement renderer (agent)");
    expect(list).toContain("└─ completed: #3 Read docs");
    expect(list).not.toContain("▸ TaskList");

    const get = collapsed(tools.get("TaskGet")!, [
      "Task #2: Implement renderer",
      "Status: in_progress",
      "Owner: agent-1",
      "Description: long noisy details",
      "Blocked by: #1",
      "Blocks: #4",
      "Metadata: {\"lane\":\"docs\"}",
    ].join("\n"));
    expect(get).toContain("├─ task: #2 Implement renderer");
    expect(get).toContain("└─ status: in_progress · owner agent-1 · blocked by #1 · blocks #4");
    expect(get).not.toContain("Description: long noisy details");

    expect(collapsed(tools.get("TaskUpdate")!, "Updated task #2 status, owner (warning: reserved metadata keys ignored: _piWorkflowPhase)"))
      .toContain("└─ warning: reserved metadata keys ignored: _piWorkflowPhase");
  });

  it("groups TaskList raw output into running, ready, blocked, and completed sections", async () => {
    const tools = registerTools();
    const create = tools.get("TaskCreate")!;
    const update = tools.get("TaskUpdate")!;
    const list = tools.get("TaskList")!;

    await create.execute!("call-1", { subject: "Run build", description: "desc" }, undefined, undefined, undefined);
    await create.execute!("call-2", { subject: "Fix ready A", description: "desc" }, undefined, undefined, undefined);
    await create.execute!("call-3", { subject: "Fix ready B", description: "desc" }, undefined, undefined, undefined);
    await create.execute!("call-4", { subject: "Wait for build", description: "desc" }, undefined, undefined, undefined);
    await create.execute!("call-5", { subject: "Document done", description: "desc" }, undefined, undefined, undefined);
    await create.execute!("call-6", { subject: "Verify done", description: "desc" }, undefined, undefined, undefined);
    await update.execute!("call-7", { taskId: "1", status: "in_progress", owner: "agent-1" }, undefined, undefined, undefined);
    await update.execute!("call-8", { taskId: "4", addBlockedBy: ["1"] }, undefined, undefined, undefined);
    await update.execute!("call-9", { taskId: "5", status: "completed" }, undefined, undefined, undefined);
    await update.execute!("call-10", { taskId: "6", status: "completed" }, undefined, undefined, undefined);

    const result = await list.execute!("call-11", {}, undefined, undefined, undefined);

    expect(result.content![0].text).toBe([
      "Running",
      "#1 [in_progress] Run build (agent-1)",
      "Ready",
      "#2 [pending] Fix ready A",
      "#3 [pending] Fix ready B",
      "Blocked",
      "#4 [pending] Wait for build [blocked by #1]",
      "Completed",
      "#5 [completed] Document done",
      "#6 [completed] Verify done",
    ].join("\n"));
  });

  it("excludes blocked and owner-assigned pending tasks from Ready", async () => {
    const tools = registerTools();
    const create = tools.get("TaskCreate")!;
    const update = tools.get("TaskUpdate")!;
    const list = tools.get("TaskList")!;

    await create.execute!("call-1", { subject: "Blocking task", description: "desc" }, undefined, undefined, undefined);
    await create.execute!("call-2", { subject: "Owner task", description: "desc" }, undefined, undefined, undefined);
    await create.execute!("call-3", { subject: "Blocked task", description: "desc" }, undefined, undefined, undefined);
    await update.execute!("call-4", { taskId: "2", owner: "agent-2" }, undefined, undefined, undefined);
    await update.execute!("call-5", { taskId: "3", addBlockedBy: ["1"] }, undefined, undefined, undefined);

    const result = await list.execute!("call-6", {}, undefined, undefined, undefined);

    expect(result.content![0].text).toBe([
      "Ready",
      "#1 [pending] Blocking task",
      "Blocked",
      "#2 [pending] Owner task (agent-2)",
      "#3 [pending] Blocked task [blocked by #1]",
    ].join("\n"));
  });

  it("summarizes process output and stop results without dumping logs", () => {
    const tools = registerTools();

    const output = collapsed(tools.get("TaskOutput")!, "Task #9 (completed) exit code: 0\n\nfirst output line\nsecond output line");
    expect(output).toContain("├─ status: completed · exit code 0");
    expect(output).toContain("└─ output: first output line");
    expect(output).not.toContain("second output line");

    expect(collapsed(tools.get("TaskStop")!, "Task #3 stopped successfully"))
      .toContain("└─ task: #3 stopped");
  });

  it("renders partial and error states safely", () => {
    const tools = registerTools();
    const partial = renderText(tools.get("TaskOutput")!.renderResult!(textResult(""), { expanded: false, isPartial: true }, plainTheme, {}));
    expect(partial).toContain("└─ status: running TaskOutput");

    const error = collapsed(tools.get("TaskStop")!, "No running background process for task 9\nstack hidden", {}, { isError: true });
    expect(error).toContain("└─ error: No running background process for task 9");
  });
});
