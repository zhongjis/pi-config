import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import diffExtension, { formatReviewPrompt, type HunkComment } from "./index.js";

vi.mock("@earendil-works/pi-tui", async () =>
  import("../../node_modules/@earendil-works/pi-tui/dist/index.js")
);

type RenderableText = { render?: (width: number) => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolResult = { content?: readonly { type: "text"; text: string }[]; details?: unknown };
type ToolDefinition = {
  name: string;
  renderCall?: (args: Record<string, unknown>, theme: PlainTheme, context?: unknown) => RenderableText;
  renderResult?: (
    result: ToolResult,
    options: { expanded?: boolean; isPartial?: boolean },
    theme: PlainTheme,
    context?: { args?: Record<string, unknown>; isError?: boolean },
  ) => RenderableText;
};

type MockPi = {
  registerCommand: (name: string, command: unknown) => void;
  registerTool: (tool: ToolDefinition) => void;
  exec: () => never;
  events: { emit: () => never };
  getActiveTools: () => never;
  setActiveTools: () => never;
  sendUserMessage: () => never;
};

const plainTheme: PlainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

function renderText(component: RenderableText, width = 120): string {
  if (typeof component.render === "function") return component.render(width).join("\n");
  return component.text ?? "";
}

function expectWidthSafe(component: RenderableText): void {
  expect(component.render).toBeTypeOf("function");
  for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
    for (const line of component.render!(width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
}

function registerOpenPrWalkthroughTool(): ToolDefinition {
  let registered: ToolDefinition | undefined;
  const pi: MockPi = {
    registerCommand: vi.fn(),
    registerTool(tool) {
      registered = tool;
    },
    exec: () => { throw new Error("renderer must not exec"); },
    events: { emit: () => { throw new Error("renderer must not emit events"); } },
    getActiveTools: () => { throw new Error("renderer must not read active tools"); },
    setActiveTools: () => { throw new Error("renderer must not set active tools"); },
    sendUserMessage: () => { throw new Error("renderer must not send messages"); },
  };
  diffExtension(pi as never);
  expect(registered).toBeDefined();
  return registered!;
}

function textResult(text: string): ToolResult {
  return Object.freeze({ content: Object.freeze([Object.freeze({ type: "text" as const, text })]) });
}

describe("open_pr_walkthrough rendering", () => {
  it("renders sidecar and SHA in calls without side effects", () => {
    const tool = registerOpenPrWalkthroughTool();
    const call = tool.renderCall!({ sidecarPath: "/tmp/pi-diff-walkthrough.json", sha: "1234567890abcdef" }, plainTheme);

    expect(renderText(call)).toContain("▸ open_pr_walkthrough · sidecar: /tmp/pi-diff-walkthrough.json · sha: 1234567890ab");
    expectWidthSafe(call);
  });

  it("distinguishes missing sidecar, missing SHA, launch failure, no comments, and local comments", () => {
    const tool = registerOpenPrWalkthroughTool();
    const comments: HunkComment[] = [
      { file: "src/a.ts", line: 4, summary: "Fix wording", source: "user" },
      { file: "src/b.ts", line: null, summary: "Clarify intent", source: null },
    ];
    const rawComments = formatReviewPrompt(comments);

    expect(renderText(tool.renderResult!(textResult("Sidecar not found at /tmp/missing. Write the agent-context JSON first, then call open_pr_walkthrough again."), { expanded: false }, plainTheme, {})))
      .toContain("status: blocked · sidecar missing");
    expect(renderText(tool.renderResult!(textResult("Missing sha to diff against."), { expanded: false }, plainTheme, {})))
      .toContain("status: blocked · sha missing");
    expect(renderText(tool.renderResult!(textResult("Failed to launch hunk: ENOENT"), { expanded: false }, plainTheme, {})))
      .toContain("status: failed · hunk launch");
    expect(renderText(tool.renderResult!(textResult("Walkthrough closed — the user left no comments."), { expanded: false }, plainTheme, {})))
      .toContain("comments: 0 local");

    const captured = tool.renderResult!(textResult(rawComments), { expanded: false }, plainTheme, {});
    expect(renderText(captured)).toContain("status: comments captured · 2 local");
    expect(renderText(captured)).toContain("next: address user comments");
    expect(tool.renderResult!(textResult(rawComments), { expanded: true }, plainTheme, {}).text).toBe(rawComments);
    expectWidthSafe(captured);
  });
});
