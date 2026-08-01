import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskRuntime } from "../src/lifecycle/store-glue.js";
import { registerTaskTools } from "../src/tools/index.js";

type RenderableText = { render?: (width: number) => string[]; text?: string };
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
  execute?: (...args: unknown[]) => Promise<ToolResult>;
};

const plainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

function renderText(component: RenderableText, width = 120): string {
  if (typeof component.render === "function") return component.render(width).join("\n");
  return component.text ?? "";
}

function expectWidthSafe(component: RenderableText): void {
  if (typeof component.render !== "function") return;
  for (const width of [20, 40, 80, 120]) {
    for (const line of component.render(width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
}

function expectCollapsedRowBudget(component: RenderableText): void {
  const rows = (component.text ?? "").split(/\r\n?|\n/).length;
  expect(rows).toBeLessThanOrEqual(3);
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function registerTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const runtime = createTaskRuntime();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand: vi.fn(),
  };

  registerTaskTools({ pi, runtime } as never);
  return tools;
}

function taskTool(): ToolDefinition {
  return registerTools().get("Task")!;
}

function collapsedComponent(
  tool: ToolDefinition,
  raw: string,
  args: Record<string, unknown> = {},
  extra: { isError?: boolean; isPartial?: boolean } = {},
): RenderableText {
  return tool.renderResult!(
    { ...textResult(raw), isError: extra.isError },
    { expanded: false, isPartial: extra.isPartial },
    plainTheme,
    { args, isError: extra.isError },
  );
}

function collapsed(
  tool: ToolDefinition,
  raw: string,
  args: Record<string, unknown> = {},
  extra: { isError?: boolean; isPartial?: boolean } = {},
): string {
  return renderText(collapsedComponent(tool, raw, args, extra));
}

beforeEach(() => {
  process.env.PI_TASKS = "off";
});

afterEach(() => {
  delete process.env.PI_TASKS;
  vi.restoreAllMocks();
});

describe("Task tool rendering", () => {
  it("registers exactly one Task tool with call and result renderers", () => {
    const tools = registerTools();
    expect([...tools.keys()].sort()).toEqual(["Task"]);
    const tool = tools.get("Task")!;
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
  });

  it("renders compact calls keyed by op", () => {
    const tool = taskTool();

    expect(tool.renderCall!({ op: "create", tasks: [{ subject: "Polish renderer", description: "d" }] }, plainTheme).text)
      .toBe("▸ Task · create (1)");
    expect(tool.renderCall!({ op: "update", tasks: [{ taskId: "7", status: "in_progress", owner: "worker" }] }, plainTheme).text)
      .toBe("▸ Task · update (1)");
    expect(tool.renderCall!({ op: "list" }, plainTheme).text).toBe("▸ Task · list");
    expect(tool.renderCall!({ op: "get", taskId: "7" }, plainTheme).text).toBe("▸ Task · get #7");
  });

  it("keeps expanded output exact and lifecycle strings byte-exact", async () => {
    const tool = taskTool();
    const createResult = await tool.execute!("call-1", { op: "create", tasks: [{ subject: "Keep raw", description: "Desc" }] }, undefined, undefined, undefined);
    await tool.execute!("call-2", { op: "create", tasks: [{ subject: "List raw", description: "Desc" }] }, undefined, undefined, undefined);
    const listResult = await tool.execute!("call-3", { op: "list" }, undefined, undefined, undefined);
    const raw = listResult.content![0].text;
    const expanded = tool.renderResult!(listResult, { expanded: true }, plainTheme, { args: { op: "list" } });

    expect(expanded.text).toBe(raw);
    expect(createResult.content![0].text).toBe("Created 1 task: #1\n#1: Keep raw");
    expect(raw).toBe([
      "Ready",
      "#1 [pending] Keep raw",
      "#2 [pending] List raw",
    ].join("\n"));
  });

  it("summarizes create, update, list, and get as workflow actions", () => {
    const tool = taskTool();

    expect(collapsed(tool, "Created 1 task: #1\n#1: Polish task renderer", { op: "create" }))
      .toContain("├─ action: created 1 · #1");

    const list = collapsed(tool, [
      "Running",
      "#2 [in_progress] Implement renderer (agent)",
      "Ready",
      "#4 [pending] Verify tests",
      "Blocked",
      "#1 [pending] Inspect output [blocked by #3]",
      "Completed",
      "#3 [completed] Read docs",
    ].join("\n"), { op: "list" });
    expect(list).toContain("├─ tasks: 4 total · 1 running, 1 ready, 1 blocked, 1 completed");
    expect(list).toContain("├─ next: running #2 Implement renderer (agent)");
    expect(list).toContain("└─ app.tools.expand to expand full result");
    expect(list).not.toContain("ready: #4 Verify tests");
    expect(list).not.toContain("completed: #3 Read docs");
    expect(list).not.toContain("▸ Task");

    const get = collapsed(tool, [
      "Task #2: Implement renderer",
      "Status: in_progress",
      "Owner: agent-1",
      "Description: long noisy details",
      "Blocked by: #1",
      "Blocks: #4",
      "Metadata: {\"lane\":\"docs\"}",
    ].join("\n"), { op: "get" });
    expect(get).toContain("├─ task: #2 Implement renderer");
    expect(get).toContain("├─ status: in_progress · owner agent-1 · blocked by #1 · blocks #4");
    expect(get).toContain("└─ app.tools.expand to expand full result");
    expect(get).not.toContain("Description: long noisy details");

    const update = collapsed(
      tool,
      "Updated 1 task: #2 (status, owner) [warning: reserved metadata keys ignored: _piWorkflowPhase]",
      { op: "update" },
    );
    expect(update).toContain("action: updated 1 · #2 (status, owner)");

    const mixed = collapsed(
      tool,
      "Updated 1 task: #2 (status)\nRejected 1 task: #1 (tasks.fsm.illegal-transition)",
      { op: "update" },
    );
    expect(mixed).toContain("├─ action: updated 1 · #2 (status)");
    expect(mixed).toContain("├─ rejected: 1 · #1 (tasks.fsm.illegal-transition)");
  });

  it("expands a batch update into a per-item report; single-item stays inline", () => {
    const tool = taskTool();
    const expandUpdate = (raw: string) =>
      renderText(tool.renderResult!(
        { content: [{ type: "text", text: raw }], details: {} },
        { expanded: true },
        plainTheme,
        { args: { op: "update" } },
      ));

    // Batch: crammed line becomes a per-item report (no raw dump).
    expect(expandUpdate("Updated 3 tasks: #9 (status), #10 (status), #8 (status)")).toBe(
      ["Updated 3 tasks", "  #9 (status)", "  #10 (status)", "  #8 (status)"].join("\n"),
    );
    // Mixed: applied reformatted, single-item rejected stays inline.
    expect(expandUpdate("Updated 2 tasks: #7 (status), #8 (status)\nRejected 1 task: #6 (blocked)")).toBe(
      ["Updated 2 tasks", "  #7 (status)", "  #8 (status)", "Rejected 1 task: #6 (blocked)"].join("\n"),
    );
    // Single item: unchanged (already clean).
    expect(expandUpdate("Updated 1 task: #2 (status, owner)")).toBe("Updated 1 task: #2 (status, owner)");
  });

  it("groups list raw output without changing execution behavior", async () => {
    const tool = taskTool();

    await tool.execute!("call-1", { op: "create", tasks: [
      { subject: "Run build", description: "desc" },
      { subject: "Fix ready A", description: "desc" },
      { subject: "Fix ready B", description: "desc" },
      { subject: "Wait for build", description: "desc" },
      { subject: "Document done", description: "desc" },
      { subject: "Verify done", description: "desc" },
    ] }, undefined, undefined, undefined);
    await tool.execute!("call-7", { op: "update", tasks: [{ taskId: "1", status: "in_progress", owner: "agent-1" }] }, undefined, undefined, undefined);
    await tool.execute!("call-8", { op: "update", tasks: [{ taskId: "4", addBlockedBy: ["1"] }] }, undefined, undefined, undefined);
    await tool.execute!("call-9", { op: "update", tasks: [{ taskId: "5", status: "completed" }] }, undefined, undefined, undefined);
    await tool.execute!("call-10", { op: "update", tasks: [{ taskId: "6", status: "completed" }] }, undefined, undefined, undefined);

    const result = await tool.execute!("call-11", { op: "list" }, undefined, undefined, undefined);
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
    const tool = taskTool();

    await tool.execute!("call-1", { op: "create", tasks: [
      { subject: "Blocking task", description: "desc" },
      { subject: "Owner task", description: "desc" },
      { subject: "Blocked task", description: "desc" },
    ] }, undefined, undefined, undefined);
    await tool.execute!("call-4", { op: "update", tasks: [{ taskId: "2", owner: "agent-2" }] }, undefined, undefined, undefined);
    await tool.execute!("call-5", { op: "update", tasks: [{ taskId: "3", addBlockedBy: ["1"] }] }, undefined, undefined, undefined);

    const result = await tool.execute!("call-6", { op: "list" }, undefined, undefined, undefined);
    expect(result.content![0].text).toBe([
      "Ready",
      "#1 [pending] Blocking task",
      "Blocked",
      "#2 [pending] Owner task (agent-2)",
      "#3 [pending] Blocked task [blocked by #1]",
    ].join("\n"));
  });

  it("renders partial and error states safely without continuation text", () => {
    const tool = taskTool();
    const partial = collapsed(tool, "", { op: "list" }, { isPartial: true });
    expect(partial).toContain("└─ status: running Task list");

    const error = collapsed(
      tool,
      "Rejected 1 task: #9 (tasks.fsm.illegal-transition)\nstack hidden",
      { op: "update" },
      { isError: true },
    );
    expect(error).toContain("├─ error: Rejected 1 task: #9 (tasks.fsm.illegal-transition)");
    expect(error).not.toContain("continuation reminder");
  });

  it("keeps frozen inputs unchanged, complete, width-safe, and within three logical rows", () => {
    const tool = taskTool();
    const cases: ReadonlyArray<{ args: Record<string, unknown>; raw: string }> = [
      { args: { op: "create", tasks: [{ subject: "整理 Unicode renderer", description: "d" }] }, raw: "Created 1 task: #1\n#1: 整理 Unicode renderer" },
      { args: { op: "update", tasks: [{ taskId: "2", status: "in_progress" }] }, raw: "Updated 1 task: #2 (status)" },
      { args: { op: "list" }, raw: "Running\n#2 [in_progress] 整理 renderer\nReady\n#3 [pending] Verify" },
      { args: { op: "get", taskId: "2" }, raw: "Task #2: 整理 renderer\nStatus: in_progress\nBlocked by: #1" },
    ];

    for (const testCase of cases) {
      const args = testCase.args;
      const details: Record<string, unknown> = { marker: "unchanged" };
      const content = [{ type: "text" as const, text: testCase.raw }];
      const result: ToolResult = { content, details };
      Object.freeze(args);
      Object.freeze(details);
      Object.freeze(content[0]);
      Object.freeze(content);
      Object.freeze(result);

      const call = tool.renderCall!(args, plainTheme);
      const summary = tool.renderResult!(result, { expanded: false }, plainTheme, { args });
      const expanded = tool.renderResult!(result, { expanded: true }, plainTheme, { args });

      expectWidthSafe(call);
      expectWidthSafe(summary);
      expectWidthSafe(expanded);
      expectCollapsedRowBudget(summary);
      expect(expanded.text).toBe(testCase.raw);
      expect(result.content).toBe(content);
      expect(result.details).toBe(details);
      expect(result.content![0].text).toBe(testCase.raw);
    }
  });
});
