import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  extractToolText,
  firstMeaningfulLine,
  renderToolCall,
  renderToolExpanded,
  renderToolSummary,
  shortenHomePath,
} from "../tool-output.js";

vi.mock("@earendil-works/pi-tui", async () =>
  import("../../../node_modules/@earendil-works/pi-tui/dist/index.js")
);

const plainTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

const markdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

function expectWidthSafe(component: { render(width: number): string[] }): void {
  for (const width of [0, Number.NaN, 20, 40, 80, 120]) {
    const safeWidth = Number.isFinite(width) ? width : 0;
    for (const line of component.render(width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${String(width)}`).toBeLessThanOrEqual(safeWidth);
    }
  }
}

describe("shared tool-output primitives", () => {
  it("extracts text parts without mutating the result", () => {
    const image = Object.freeze({ type: "image", data: "abc", mimeType: "image/png" });
    const first = Object.freeze({ type: "text", text: "first" });
    const second = Object.freeze({ type: "text", text: "second" });
    const content = Object.freeze([image, first, second]);
    const result = Object.freeze({ content });

    expect(extractToolText(result)).toBe("first\nsecond");
    expect(result.content).toEqual([image, first, second]);
    expect(extractToolText(undefined)).toBe("");
    expect(extractToolText({ content: [{ type: "text", text: 42 }] })).toBe("");
  });

  it("finds the first visible meaningful line across ANSI and CJK text", () => {
    expect(firstMeaningfulLine("\r\n\u001b[31m\u001b[0m\n  \u001b[32m你好\u001b[0m  \nlast")).toBe("\u001b[32m你好\u001b[0m");
    expect(firstMeaningfulLine("\n\t\r\n")).toBe("");
  });

  it("shortens only paths inside the home directory boundary", () => {
    expect(shortenHomePath("/home/alice", "/home/alice")).toBe("~");
    expect(shortenHomePath("/home/alice/project/file.ts", "/home/alice")).toBe("~/project/file.ts");
    expect(shortenHomePath("/home/alice2/file.ts", "/home/alice")).toBe("/home/alice2/file.ts");
  });

  it("renders ANSI/CJK call headers with a Text component at every width", () => {
    const component = renderToolCall("读取", "\u001b[36m~/项目/very-long-unbroken-target.ts\u001b[0m", plainTheme);

    expect(component).toBeInstanceOf(Text);
    expect(component.render(80).join("\n")).toContain("▸ 读取 ·");
    expectWidthSafe(component);
  });

  it("renders collapsed summaries with configured expand hint and no input mutation", () => {
    const lines = Object.freeze(["status: 完成", "output: \u001b[32mcombined e\u0301 text\u001b[0m"]);
    const component = renderToolSummary(lines, plainTheme, { expandable: true });

    expect(component).toBeInstanceOf(Text);
    expect(component.render(80).join("\n")).toContain("app.tools.expand to expand full result");
    expect(lines).toEqual(["status: 完成", "output: \u001b[32mcombined e\u0301 text\u001b[0m"]);
    expectWidthSafe(component);
    expect(component.render(20)).toHaveLength(3);
    const embeddedNewline = renderToolSummary(["status: complete\r\ncontinued", "count: 31"], plainTheme, { expandable: true });
    expect(embeddedNewline.render(80)).toHaveLength(3);
    expect(embeddedNewline.render(80).join("\n")).toContain("status: complete continued");
  });

  it("omits expand hint when expanded content adds nothing", () => {
    const rendered = renderToolSummary(["status: complete"], plainTheme).render(80).join("\n");

    expect(rendered).not.toContain("app.tools.expand");
  });

  it("renders expanded plain text with Text and markdown with Markdown", () => {
    const plain = renderToolExpanded("plain \u001b[35m你好\u001b[0m output");
    const markdown = renderToolExpanded("- 项目\n\n```ts\nconst value = 'long-unbroken-value';\n```", {
      format: "markdown",
      markdownTheme,
    });

    expect(plain).toBeInstanceOf(Text);
    expect(markdown).toBeInstanceOf(Markdown);
    expectWidthSafe(plain);
    expectWidthSafe(markdown);
  });
});
