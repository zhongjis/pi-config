import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createWriteTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

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
  content: Array<{ type?: string; text?: string }>;
};

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

    renderCall(args: WriteToolArgs, theme: ExtensionContext["ui"]["theme"], _context: unknown) {
      let text = theme.fg("toolTitle", theme.bold("write "));
      text += theme.fg("accent", args.path);
      const lineCount = args.content.split("\n").length;
      text += theme.fg("dim", ` (${lineCount} lines)`);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: ToolResult,
      { isPartial }: { isPartial: boolean },
      theme: ExtensionContext["ui"]["theme"],
      _context: unknown,
    ) {
      if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);

      const content = result.content[0];
      if (content?.type === "text" && content.text?.startsWith("Error")) {
        return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
      }

      return new Text(theme.fg("success", "✓ Written"), 0, 0);
    },
  });
}
