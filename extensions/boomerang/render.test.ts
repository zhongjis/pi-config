import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", async () =>
  import("../../node_modules/@earendil-works/pi-tui/dist/index.js"),
);

import { renderBoomerangCall, renderBoomerangResult } from "./render.js";

type RenderableText = { render(width: number): string[] };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolResult = { content?: ReadonlyArray<{ type: "text"; text: string }>; details?: unknown; isError?: boolean };

const plainTheme: PlainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

function renderText(component: RenderableText, width = 120): string {
  return component.render(width).join("\n");
}

function textResult(text: string, extras: Omit<ToolResult, "content"> = {}): ToolResult {
  return { content: [{ type: "text", text }], ...extras };
}

function collapsed(result: ToolResult, extra: { isPartial?: boolean; isError?: boolean } = {}): string {
  return renderText(
    renderBoomerangResult(
      { ...result, isError: extra.isError ?? result.isError },
      { expanded: false, isPartial: extra.isPartial },
      plainTheme,
      { isError: extra.isError },
    ),
  );
}

function expanded(result: ToolResult): string {
  return renderText(renderBoomerangResult(result, { expanded: true }, plainTheme));
}

function expectWidthSafe(component: RenderableText): void {
  expect(component.render).toBeTypeOf("function");
  for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
    for (const line of component.render!(width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
}

describe("boomerang tool rendering", () => {
  it("renders task previews, recognized --rethrow, and no-task anchor mode in calls", () => {
    const taskCall = renderBoomerangCall({ task: "fix auth regression" }, plainTheme);
    const rethrowCall = renderBoomerangCall({ task: "fix auth --rethrow 3 -- --keep-global" }, plainTheme);
    const anchorCall = renderBoomerangCall({}, plainTheme);

    expect(renderText(taskCall)).toContain("▸ boomerang · task: fix auth regression");
    expect(renderText(rethrowCall)).toContain("task: fix auth -- --keep-global · --rethrow 3");
    expect(renderText(anchorCall)).toContain("▸ boomerang · anchor mode");
    expectWidthSafe(taskCall);
    expectWidthSafe(rethrowCall);
    expectWidthSafe(anchorCall);
  });

  it("distinguishes all exact owner outcomes", () => {
    const cases = [
      ["Boomerang tool is disabled. User must run `/boomerang tool on` to enable.", "status: disabled · run /boomerang tool on"],
      ["A boomerang is already active. Wait for it to complete.", "status: blocked · boomerang already active"],
      ["No command context. Run any /boomerang command first to initialize.", "status: blocked · run any /boomerang command first"],
      ["A boomerang task is already queued. Wait for it to start before queueing another task.", "status: blocked · task already queued"],
      ["Task queued: \"fix auth\". Will start autonomously when this turn ends.", "status: queued · starts after current turn"],
      ["Cannot set anchor: no session entries yet.", "status: failed · no session entries for anchor"],
      ["Boomerang anchor set. Do your work, then call boomerang again to summarize the context.", "status: anchor set · call again after work to summarize"],
      ["Boomerang complete. Context will be summarized when this turn ends.", "status: pending summary · will summarize after this turn"],
    ] as const;

    for (const [raw, expected] of cases) {
      expect(collapsed(textResult(raw))).toContain(expected);
    }
    expect(collapsed(textResult(cases[4][0]))).toContain("task: fix auth");
  });

  it("preserves frozen raw expansion and falls back for malformed or empty details", () => {
    const raw = "Boomerang raw result\n\n- full detail retained";
    const content = Object.freeze([{ type: "text" as const, text: raw }]);
    const result = Object.freeze({ content, details: Object.freeze({ broken: true }) });

    expect(expanded(result)).toContain("Boomerang raw result");
    expect(expanded(result)).toContain("- full detail retained");
    expect(result.content[0].text).toBe(raw);
    expect(collapsed({ content: [], details: "broken" })).toContain("result: no output");
    expect(collapsed(textResult("opaque owner output\nsecond line", { details: { partial: true } }))).toContain("result: opaque owner output");
  });

  it("renders partial and error states without hiding raw diagnostics in expansion", () => {
    const partial = renderBoomerangResult({ content: [] }, { expanded: false, isPartial: true }, plainTheme);
    expect(renderText(partial)).toContain("status: running · boomerang task active");

    const error = textResult("No command context. Run any /boomerang command first to initialize.\nstack hidden", { isError: true });
    expect(collapsed(error)).toContain("error: No command context. Run any /boomerang command first to initialize.");
    expect(expanded(error)).toContain("stack hidden");
  });

  it("keeps malformed, partial, error, and unicode output width-safe", () => {
    const components = [
      renderBoomerangResult(textResult("界面任务完成，路径 /tmp/very/long/path/that/does/not/break/easily/abcdef"), { expanded: false }, plainTheme),
      renderBoomerangResult(textResult("opaque owner output\nsecond line", { details: "broken" }), { expanded: false }, plainTheme),
      renderBoomerangResult({ content: [] }, { expanded: false, isPartial: true }, plainTheme),
      renderBoomerangResult(textResult("失败：组合字符 é and emoji 🪃 and ansi \u001b[31mred\u001b[0m", { isError: true }), { expanded: false }, plainTheme),
      renderBoomerangResult(textResult("# Result\n\n- 界面 item\n- /tmp/very/long/path/that/does/not/break/easily/abcdef"), { expanded: true }, plainTheme),
    ];

    for (const component of components) {
      expectWidthSafe(component);
    }
  });
});
