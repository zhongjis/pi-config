import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", async () =>
  import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"),
);

import multimodalLook from "../index.js";

type RenderableText = { render?: (width: number) => string[]; text?: string };
type PlainTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};
type ToolDefinition = {
  name: string;
  renderCall?: (
    args: Record<string, unknown>,
    theme: PlainTheme,
    context?: unknown,
  ) => RenderableText;
  renderResult?: (
    result: {
      content?: readonly unknown[];
      details?: unknown;
      isError?: boolean;
    },
    options: { expanded?: boolean; isPartial?: boolean },
    theme: PlainTheme,
    context?: { args?: Record<string, unknown>; isError?: boolean },
  ) => RenderableText;
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
  expect(component.render).toBeTypeOf("function");
  for (const width of [20, 40, 80, 120]) {
    for (const line of component.render!(width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
}

function registerTool(): ToolDefinition {
  let registered: ToolDefinition | undefined;
  multimodalLook({
    registerTool(tool: ToolDefinition) {
      registered = tool;
    },
  } as never);
  expect(registered).toBeDefined();
  return registered!;
}

describe("look_at tool rendering", () => {
  it("renders source, goal, and active project in the call", () => {
    const tool = registerTool();
    const fileCall = tool.renderCall!(
      { file_path: "screens/界面.png", goal: "\u001b[36mFind primary CTA\u001b[0m" },
      plainTheme,
    );
    const dataCall = tool.renderCall!({ image_data: "abc", goal: "Find logo" }, plainTheme);

    expect(renderText(fileCall)).toContain('▸ look_at · source: screens/界面.png · goal: "');
    expect(renderText(fileCall)).toContain("project: active");
    expect(renderText(dataCall)).toContain('source: image_data · goal: "Find logo" · project: active');
    expectWidthSafe(fileCall);
    expectWidthSafe(dataCall);
  });

  it("summarizes terminal state, image facts, and finding highlight", () => {
    const tool = registerTool();
    const text = renderText(
      tool.renderResult!(
        {
          content: [{ type: "text", text: "Primary CTA says Continue.\nSecondary copy is muted." }],
          details: { mimeType: "image/png", bytes: 253_952, model: "openai/gpt-5.5", fallback: false },
        },
        { expanded: false },
        plainTheme,
        { args: { file_path: "screens/login.png", goal: "find CTA" } },
      ),
    );

    expect(text).toContain("status: complete");
    expect(text).toContain("findings: Primary CTA says Continue.");
    expect(text).toContain("image: image/png · 248 KB");
    expect(text).toContain("model: openai/gpt-5.5");
    expect(text).toContain("app.tools.expand to expand full result");
  });

  it("preserves frozen raw expansion and falls back when details are malformed", () => {
    const tool = registerTool();
    const raw = "\u001b[32m界面分析完成\u001b[0m\n\n- Primary CTA visible\n- No errors";
    const content = Object.freeze([{ type: "text" as const, text: raw }]);
    const result = Object.freeze({ content, details: Object.freeze({ bytes: "broken" }) });
    const expanded = tool.renderResult!(result, { expanded: true }, plainTheme, {
      args: { image_data: "abc", goal: "inspect form" },
    });

    expect(expanded.text).toBe(raw);
    expect(result.content[0].text).toBe(raw);
    expectWidthSafe(expanded);

    const malformed = tool.renderResult!(
      { content: [{ type: "text", text: "raw owner fallback\nopaque detail" }], details: "broken" },
      { expanded: false },
      plainTheme,
      {},
    );
    expect(renderText(malformed)).toContain("findings: raw owner fallback");
  });

  it("renders image analysis partial state and decisive errors", () => {
    const tool = registerTool();
    const partial = tool.renderResult!(
      { content: [], details: {} },
      { expanded: false, isPartial: true },
      plainTheme,
      { args: { file_path: "screens/login.png", goal: "inspect form" } },
    );
    expect(renderText(partial)).toContain("status: running · image analysis");

    const error = tool.renderResult!(
      {
        content: [{ type: "text", text: 'look_at unsupported mime_type "image/bmp". Supported: image/png, image/jpeg.\nstack hidden' }],
        details: {},
        isError: true,
      },
      { expanded: false },
      plainTheme,
      { isError: true },
    );
    const errorText = renderText(error);
    expect(errorText).toContain('error: look_at unsupported mime_type "image/bmp". Supported: image/png, image/jpeg.');
    expect(errorText).not.toContain("stack hidden");
  });

  it("keeps ANSI/CJK output safe at 20/40/80/120 columns", () => {
    const tool = registerTool();
    const result = tool.renderResult!(
      {
        content: [{ type: "text", text: "\u001b[31m界面中主要按钮包含很长的验证说明和操作指引\u001b[0m" }],
        details: { mimeType: "image/png", bytes: 253_952, model: "openai/gpt-5.5" },
      },
      { expanded: false },
      plainTheme,
      {},
    );
    expectWidthSafe(result);
  });
});
