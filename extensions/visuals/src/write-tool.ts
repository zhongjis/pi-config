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

    renderCall(args: WriteToolArgs, theme: ExtensionContext["ui"]["theme"], context: { isPartial?: boolean }) {
      let text = theme.fg("toolTitle", theme.bold("write "));
      text += theme.fg("accent", args?.path ?? "");
      const content = typeof args?.content === "string" ? args.content : "";
      const lineCount = content ? content.split("\n").length : 0;
      const suffix = context?.isPartial
        ? ` (writing… ${lineCount} line${lineCount === 1 ? "" : "s"})`
        : ` (${lineCount} line${lineCount === 1 ? "" : "s"})`;
      text += theme.fg("dim", suffix);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: ToolResult,
      { isPartial }: { isPartial: boolean },
      theme: ExtensionContext["ui"]["theme"],
      context: { isError?: boolean },
    ) {
      if (isPartial) return new Text(theme.fg("warning", "Writing…"), 0, 0);

      if (context?.isError) {
        const message = (result?.content ?? [])
          .map((c) => c?.text ?? "")
          .filter(Boolean)
          .join(" ")
          .split("\n")[0]
          .trim();
        const reason = message || "unknown error";
        return new Text(theme.fg("error", `✗ Failed: ${reason}`), 0, 0);
      }

      return new Text(theme.fg("success", "✓ Written"), 0, 0);
    },
  });
}
