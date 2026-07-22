import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import secondOpinion from "../index.js";

vi.mock("@earendil-works/pi-tui", async () =>
  import("../../../node_modules/@earendil-works/pi-tui/dist/index.js")
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
  registerTool: (tool: ToolDefinition) => void;
  registerCommand: (name: string, command: unknown) => void;
  registerFlag: (flag: unknown) => void;
  on: (event: string, handler: unknown) => void;
  sendMessage: () => never;
  sendUserMessage: () => never;
  exec: () => never;
  events: { emit: () => never };
  getActiveTools: () => never;
  setActiveTools: () => never;
};

const plainTheme: PlainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

const args = Object.freeze({
  reason: "agent selected implementation files",
  repos: Object.freeze([
    Object.freeze({ path: "/repo/a", include: Object.freeze(["src/a.ts"]), exclude: Object.freeze(["pnpm-lock.yaml"]) }),
    Object.freeze({ path: "/repo/b", include: Object.freeze(["src/b.ts"]) }),
  ]),
});

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

function registerScopeTool(): ToolDefinition {
  let registered: ToolDefinition | undefined;
  const pi: MockPi = {
    registerTool(tool) {
      registered = tool;
    },
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    on: vi.fn(),
    sendMessage: () => { throw new Error("renderer must not send messages"); },
    sendUserMessage: () => { throw new Error("renderer must not send user messages"); },
    exec: () => { throw new Error("renderer must not exec"); },
    events: { emit: () => { throw new Error("renderer must not emit events"); } },
    getActiveTools: () => { throw new Error("renderer must not read active tools"); },
    setActiveTools: () => { throw new Error("renderer must not set active tools"); },
  };
  secondOpinion(pi as never);
  expect(registered).toBeDefined();
  return registered!;
}

function textResult(text: string): ToolResult {
  return Object.freeze({ content: Object.freeze([Object.freeze({ type: "text" as const, text })]) });
}

describe("codex_review_session_scope rendering", () => {
  it("renders repo count and reason in calls without side effects", () => {
    const tool = registerScopeTool();
    const call = tool.renderCall!(args, plainTheme);

    expect(renderText(call)).toContain("▸ codex_review_session_scope · 2 repos · reason: agent selected implementation files");
    expectWidthSafe(call);
  });

  it("distinguishes plan-listed outcomes and preserves frozen raw expansion", () => {
    const tool = registerScopeTool();
    const complete = textResult("Codex scoped review complete and posted. Address-comments follow-up sent.");
    const noFollowup = textResult("Codex scoped review complete and posted.");
    const failed = textResult("Codex review failed: /repo/a: Could not determine a base ref");
    const invalid = textResult("Repo scope needs at least one included path: /repo/a");

    expect(renderText(tool.renderResult!(complete, { expanded: false }, plainTheme, { args }))).toContain("next: address-comments follow-up sent");
    expect(renderText(tool.renderResult!(noFollowup, { expanded: false }, plainTheme, { args }))).toContain("next: no follow-up requested");
    expect(renderText(tool.renderResult!(failed, { expanded: false }, plainTheme, { args }))).toContain("status: failed");
    expect(renderText(tool.renderResult!(invalid, { expanded: false }, plainTheme, { args }))).toContain("status: blocked · invalid scope");

    const expanded = tool.renderResult!(complete, { expanded: true }, plainTheme, { args });
    expect(expanded.text).toBe("Codex scoped review complete and posted. Address-comments follow-up sent.");
    expect(complete.content![0].text).toBe("Codex scoped review complete and posted. Address-comments follow-up sent.");
    expectWidthSafe(tool.renderResult!(complete, { expanded: false }, plainTheme, { args }));
  });
});
