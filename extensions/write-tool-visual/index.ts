import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createWriteTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export default function writeToolVisual(pi: ExtensionAPI): void {
  const originalWrite = createWriteTool(process.cwd());

  pi.registerTool({
    name: "write",
    label: "write",
    description: originalWrite.description,
    parameters: originalWrite.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalWrite.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("write "));
      text += theme.fg("accent", args.path);
      const lineCount = args.content.split("\n").length;
      text += theme.fg("dim", ` (${lineCount} lines)`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme, _context) {
      if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);

      const content = result.content[0];
      if (content?.type === "text" && content.text.startsWith("Error")) {
        return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
      }

      return new Text(theme.fg("success", "✓ Written"), 0, 0);
    },
  });
}
