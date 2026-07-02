import { createWriteTool, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
// @ts-expect-error LSP may miss the repo test/runtime alias for pi-tui; runtime/test alias resolves it.
import { Text } from "@earendil-works/pi-tui";

type BuiltInWriteTool = {
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<unknown>;
};

type WriteToolArgs = {
  path: string;
  content: string;
};

type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

type RenderResultOptions = {
  expanded?: boolean;
  isPartial?: boolean;
};

type RenderResultContext = {
  args?: Partial<WriteToolArgs>;
  isError?: boolean;
};

type ToolTheme = ExtensionContext["ui"]["theme"];
type ToolThemeColor = Parameters<ToolTheme["fg"]>[0];

const WRITE_CALL_PATH_MAX_CHARS = 44;
const WRITE_SUMMARY_MAX_CHARS = 76;
const ELLIPSIS = "…";

function style(theme: ToolTheme, color: ToolThemeColor, text: string): string {
  return theme.fg(color, text);
}

function styleToolTitle(theme: ToolTheme, text: string): string {
  return style(theme, "toolTitle", theme.bold(text));
}

function truncateMiddle(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxChars);

  const keep = maxChars - ELLIPSIS.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${chars.slice(0, head).join("")}${ELLIPSIS}${chars.slice(chars.length - tail).join("")}`;
}

function truncateEnd(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxChars);
  return `${chars.slice(0, maxChars - ELLIPSIS.length).join("")}${ELLIPSIS}`;
}

function getResultText(result: ToolResult | undefined): string {
  return (result?.content ?? [])
    .filter((part) => !part?.type || part.type === "text")
    .map((part) => part?.text ?? "")
    .join("\n");
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function formatLineCount(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}

function firstDecisiveLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "unknown error";
}

function renderSummary(lines: string[], theme: ToolTheme): Text {
  const details = [...lines, keyHint("app.tools.expand", "to expand full result")];
  const rendered = details
    .map((line, index) => `${index === details.length - 1 ? "└─" : "├─"} ${line}`)
    .map((line) => style(theme, "muted", line))
    .join("\n");
  return new Text(rendered, 0, 0);
}

export function installWriteToolVisual(pi: ExtensionAPI): void {
  const originalWrite = createWriteTool(process.cwd()) as BuiltInWriteTool;
  const registerTool = pi.registerTool as (tool: unknown) => void;

  registerTool({
    name: "write",
    label: "write",
    description: originalWrite.description,
    parameters: originalWrite.parameters,

    async execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) {
      return originalWrite.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args: Partial<WriteToolArgs> | undefined, theme: ToolTheme) {
      const rawPath = typeof args?.path === "string" ? args.path : "";
      const path = truncateMiddle(rawPath, WRITE_CALL_PATH_MAX_CHARS);
      return new Text(
        `▸ ${styleToolTitle(theme, "write")} ${style(theme, "dim", "·")} ${style(theme, "accent", path)}`,
        0,
        0,
      );
    },

    renderResult(
      result: ToolResult | undefined,
      options: RenderResultOptions = {},
      theme: ToolTheme,
      context: RenderResultContext = {},
    ) {
      const text = getResultText(result);
      if (options.expanded) return new Text(text, 0, 0);

      if (options.isPartial) return renderSummary(["status: writing"], theme);

      if (context.isError || result?.isError) {
        return renderSummary(
          [`error: ${truncateEnd(firstDecisiveLine(text), WRITE_SUMMARY_MAX_CHARS)}`],
          theme,
        );
      }

      const writtenContent =
        typeof context.args?.content === "string" ? context.args.content : text;
      return renderSummary(
        ["status: written", `size: ${formatLineCount(countLines(writtenContent))}`],
        theme,
      );
    },
  });
}
