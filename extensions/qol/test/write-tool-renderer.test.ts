import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

const builtInWrite = vi.hoisted(() => {
  const parameters = Object.freeze({ type: "object" });
  const execute = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    content: [{ type: "text" as const, text: "Successfully wrote 0 bytes to file" }],
    details: undefined,
  }));
  return {
    execute,
    parameters,
    createWriteTool: vi.fn(() => ({
      description: "built-in write",
      parameters,
      execute,
    })),
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createWriteTool: builtInWrite.createWriteTool,
  };
});

import { installWriteToolVisual } from "../src/write-tool-renderer.js";

type RenderableText = { text?: string; render?: (width: number) => string[] };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
  renderCall?: (args: Record<string, unknown>, theme: PlainTheme) => RenderableText;
  renderResult?: (
    result: { content?: Array<{ type: "text"; text: string }>; isError?: boolean },
    options: { expanded?: boolean; isPartial?: boolean },
    theme: PlainTheme,
    context?: { args?: Record<string, unknown>; isError?: boolean },
  ) => RenderableText;
  execute: (...args: unknown[]) => Promise<unknown>;
};

const plainTheme: PlainTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function renderText(component: RenderableText, width = 120): string {
  if (typeof component.render === "function") return component.render(width).join("\n");
  return component.text ?? "";
}

function expectWidthSafe(component: RenderableText): void {
  for (const width of [20, 40, 80, 120]) {
    const lines = typeof component.render === "function" ? component.render(width) : (component.text ?? "").split("\n");
    for (const line of lines) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

function installTool(): ToolDefinition {
  let registered: ToolDefinition | undefined;
  installWriteToolVisual({
    registerTool(tool: ToolDefinition) {
      registered = tool;
    },
  } as never);

  expect(registered).toBeDefined();
  return registered!;
}

describe("qol write tool rendering", () => {
  it("reuses the built-in write description and parameter schema", () => {
    const tool = installTool();

    expect(tool.description).toBe("built-in write");
    expect(tool.parameters).toBe(builtInWrite.parameters);
  });

  it("renders collapsed success as short keyword lines", () => {
    const tool = installTool();
    const result = { content: [{ type: "text" as const, text: "Successfully wrote 11 bytes to src/app.ts" }] };

    const collapsed = renderText(tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      { args: { content: "first\nsecond" } },
    ));

    expect(collapsed).toBe([
      "├─ status: written",
      "├─ size: 2 lines",
      "└─ app.tools.expand to expand full result",
    ].join("\n"));
    expect(collapsed).not.toContain("Successfully wrote");
  });

  it("passes all five execute arguments through and preserves native result identity", async () => {
    const tool = installTool();
    const nativeResult = deepFreeze({
      content: [{ type: "text" as const, text: "Successfully wrote 11 bytes to src/app.ts" }],
      details: { path: "src/app.ts", bytes: 11 },
    });
    const toolCallId = "call-1";
    const params = Object.freeze({ path: "src/app.ts", content: "hello" });
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    const ctx = Object.freeze({ cwd: "/workspace" });
    builtInWrite.execute.mockResolvedValueOnce(nativeResult);

    const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);

    expect(builtInWrite.execute).toHaveBeenLastCalledWith(
      toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
    );
    expect(result).toBe(nativeResult);
    expect(result).toEqual({
      content: [{ type: "text", text: "Successfully wrote 11 bytes to src/app.ts" }],
      details: { path: "src/app.ts", bytes: 11 },
    });
  });

  it("keeps collapsed success width-safe at required widths", () => {
    const tool = installTool();
    const result = { content: [{ type: "text" as const, text: "Successfully wrote 11 bytes to src/app.ts" }] };

    const collapsed = tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      { args: { content: "first\nsecond" } },
    );

    expectWidthSafe(collapsed);
  });

  it("renders expanded raw output exactly and leaves result content unchanged", () => {
    const tool = installTool();
    const raw = "Successfully wrote 11 bytes to src/app.ts\nsecond raw line";
    const result = { content: [{ type: "text" as const, text: raw }] };

    const expanded = renderText(tool.renderResult!(result, { expanded: true, isPartial: false }, plainTheme));

    expect(expanded).toBe(raw);
    expect(result.content[0].text).toBe(raw);
  });

  it("renders error summary with first decisive line and expand hint", () => {
    const tool = installTool();
    const result = { content: [{ type: "text" as const, text: "\nError: EACCES denied\nstack hidden" }] };

    const collapsed = renderText(tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      { isError: true },
    ));

    expect(collapsed).toBe([
      "├─ error: Error: EACCES denied",
      "└─ app.tools.expand to expand full result",
    ].join("\n"));
    expect(collapsed).not.toContain("stack hidden");
  });

  it("keeps collapsed error width-safe at required widths", () => {
    const tool = installTool();
    const result = { content: [{ type: "text" as const, text: `Error: ${"permission context ".repeat(20)}` }] };

    const collapsed = tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      { isError: true },
    );

    expectWidthSafe(collapsed);
  });

  it("renders partial/running summary with expand hint", () => {
    const tool = installTool();
    const result = { content: [{ type: "text" as const, text: "partial raw output" }] };

    const partial = renderText(tool.renderResult!(result, { expanded: false, isPartial: true }, plainTheme));

    expect(partial).toBe([
      "├─ status: writing",
      "└─ app.tools.expand to expand full result",
    ].join("\n"));
    expect(partial).not.toContain("partial raw output");
  });

  it("keeps partial writing width-safe at required widths", () => {
    const tool = installTool();
    const partial = tool.renderResult!(
      { content: [{ type: "text" as const, text: "partial raw output" }] },
      { expanded: false, isPartial: true },
      plainTheme,
    );

    expectWidthSafe(partial);
  });

  it("keeps long collapsed error lines compact enough to preserve tree prefixes", () => {
    const tool = installTool();
    const longError = `Error: write failed because ${"permission context ".repeat(12)}for target path`;
    const collapsed = renderText(tool.renderResult!(
      { content: [{ type: "text", text: longError }] },
      { expanded: false, isPartial: false },
      plainTheme,
      { isError: true },
    ));

    expect(collapsed).toContain("…");
    expect(
      collapsed
        .split("\n")
        .every((line) => Array.from(line).length <= 90),
    ).toBe(true);
  });

  it("renders call header aligned with edit: home-shortened, untruncated path", () => {
    const tool = installTool();
    const shortCall = renderText(tool.renderCall!({ path: "src/app.ts", content: "" }, plainTheme));

    const homePath = `${homedir()}/personal/pi-config/docs/guides/agent-orchestration.md`;
    const homeCall = renderText(tool.renderCall!({ path: homePath, content: "" }, plainTheme));

    const longPath = `src/${"nested/".repeat(12)}final-file.ts`;
    const longCall = renderText(tool.renderCall!({ path: longPath, content: "" }, plainTheme));

    expect(shortCall).toBe("▸ write · src/app.ts");
    expect(homeCall).toBe("▸ write · ~/personal/pi-config/docs/guides/agent-orchestration.md");
    expect(longCall).toBe(`▸ write · ${longPath}`);
    expect(longCall).not.toContain("…");
    expectWidthSafe(tool.renderCall!({ path: longPath, content: "" }, plainTheme));
  });
});
