import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";

const builtInWrite = vi.hoisted(() => {
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "Successfully wrote 0 bytes to file" }],
    details: undefined,
  }));
  return {
    execute,
    createWriteTool: vi.fn(() => ({
      description: "built-in write",
      parameters: {},
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

import { installWriteToolVisual } from "../src/write-tool.js";

type RenderableText = { text?: string; render?: () => string[] };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolDefinition = {
  name: string;
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

function renderText(component: RenderableText): string {
  if (typeof component.render === "function") return component.render().join("\n");
  return component.text ?? "";
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

describe("visuals write tool rendering", () => {
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
  });
});
