import { describe, expect, it, vi } from "vitest";

import multimodalLook from "../index.js";

type RenderableText = { render?: () => string[]; text?: string };
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
      content?: Array<{ type: "text"; text: string }>;
      details?: Record<string, unknown>;
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

function renderText(component: RenderableText): string {
  if (typeof component.render === "function") return component.render().join("\n");
  return component.text ?? "";
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
  it("renders collapsed success as short keyword lines", () => {
    const tool = registerTool();
    const text = renderText(
      tool.renderResult!(
        {
          content: [
            {
              type: "text",
              text: "Primary CTA says Continue.\nSecondary copy is muted.",
            },
          ],
          details: {
            mimeType: "image/png",
            bytes: 253_952,
            model: "openai/gpt-5.5",
            fallback: false,
          },
        },
        { expanded: false, isPartial: false },
        plainTheme,
        { args: { file_path: "screens/login.png", goal: "find CTA" } },
      ),
    );

    expect(text).toContain("├─ findings: Primary CTA says Continue.");
    expect(text).toContain("├─ image: image/png · 248 KB");
    expect(text).toContain("├─ model: openai/gpt-5.5");
    expect(text).toContain("└─ app.tools.expand to expand full result");
    expect(text).not.toContain("▸ look_at");
    expect(text).not.toContain("fallback: current model");
  });

  it("renders expanded raw output exactly and leaves content unchanged", () => {
    const tool = registerTool();
    const raw = "Primary CTA says Continue.\n\nNo validation errors visible.";
    const content = [{ type: "text" as const, text: raw }];
    const result = { content, details: { model: "openai/gpt-5.5" } };

    const expanded = renderText(
      tool.renderResult!(
        result,
        { expanded: true, isPartial: false },
        plainTheme,
        { args: { image_data: "abc", goal: "inspect form" } },
      ),
    );

    expect(expanded).toBe(raw);
    expect(result.content).toBe(content);
    expect(result.content[0].text).toBe(raw);
  });

  it("renders error summaries with expand hint", () => {
    const tool = registerTool();
    const text = renderText(
      tool.renderResult!(
        {
          content: [
            {
              type: "text",
              text: 'look_at unsupported mime_type "image/bmp". Supported: image/png, image/jpeg.\nstack hidden',
            },
          ],
          details: {},
          isError: true,
        },
        { expanded: false, isPartial: false },
        plainTheme,
        { isError: true },
      ),
    );

    expect(text).toContain(
      '├─ error: look_at unsupported mime_type "image/bmp". Supported: image/png, image/jpeg.',
    );
    expect(text).toContain("└─ app.tools.expand to expand full result");
  });

  it("renders partial running summaries with expand hint", () => {
    const tool = registerTool();
    const text = renderText(
      tool.renderResult!(
        { content: [], details: {} },
        { expanded: false, isPartial: true },
        plainTheme,
        { args: { file_path: "screens/login.png", goal: "inspect form" } },
      ),
    );

    expect(text).toContain("├─ status: running");
    expect(text).toContain("└─ app.tools.expand to expand full result");
  });

  it("keeps long collapsed lines compact enough to preserve tree prefixes", () => {
    const tool = registerTool();
    const longFinding = `Validation banner says ${"field required ".repeat(12)}near submit button.`;
    const text = renderText(
      tool.renderResult!(
        { content: [{ type: "text", text: longFinding }], details: {} },
        { expanded: false, isPartial: false },
        plainTheme,
        {},
      ),
    );

    expect(text).toContain("…");
    expect(
      text
        .split("\n")
        .every((line) => Array.from(line).length <= 90),
    ).toBe(true);
  });

  it("renders full tool name in call header and truncates long source and goal", () => {
    const tool = registerTool();

    const imageDataHeader = renderText(
      tool.renderCall!({ image_data: "abc", goal: "Find logo" }, plainTheme),
    );
    expect(imageDataHeader).toBe('▸ look_at · image_data · "Find logo"');

    const longSource = `screenshots/${"nested-folder-".repeat(8)}image.png`;
    const longGoal = `Read every visible label and summarize spacing problems ${"carefully ".repeat(12)}`;
    const longHeader = renderText(
      tool.renderCall!({ file_path: longSource, goal: longGoal }, plainTheme),
    );

    expect(longHeader).toContain("▸ look_at · ");
    expect(longHeader).toContain("…");
    expect(longHeader).not.toContain(longSource);
    expect(longHeader).not.toContain(longGoal);
    expect(longHeader.length).toBeLessThanOrEqual(80);
  });
});
