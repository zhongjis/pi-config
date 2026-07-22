import { createWriteTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  extractToolText,
  firstMeaningfulLine,
  renderToolCall,
  renderToolExpanded,
  renderToolSummary,
  shortenHomePath,
} from "../../lib/index.js";

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

const WRITE_SUMMARY_MAX_CHARS = 76;
const ELLIPSIS = "…";

function truncateEnd(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxChars);
  return `${chars.slice(0, maxChars - ELLIPSIS.length).join("")}${ELLIPSIS}`;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function formatLineCount(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}

function firstDecisiveLine(text: string): string {
  return firstMeaningfulLine(text) || "unknown error";
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
      const path = typeof args?.path === "string" ? shortenHomePath(args.path) : "";
      return renderToolCall("write", path, theme);
    },

    renderResult(
      result: ToolResult | undefined,
      options: RenderResultOptions = {},
      theme: ToolTheme,
      context: RenderResultContext = {},
    ) {
      const text = extractToolText(result);
      if (options.expanded) return renderToolExpanded(text);

      if (options.isPartial) return renderToolSummary(["status: writing"], theme, { expandable: true });

      if (context.isError || result?.isError) {
        return renderToolSummary(
          [`error: ${truncateEnd(firstDecisiveLine(text), WRITE_SUMMARY_MAX_CHARS)}`],
          theme,
          { expandable: true },
        );
      }

      const writtenContent =
        typeof context.args?.content === "string" ? context.args.content : text;
      return renderToolSummary(
        ["status: written", `size: ${formatLineCount(countLines(writtenContent))}`],
        theme,
        { expandable: true },
      );
    },
  });
}
