import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import {
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  keyHint,
  truncateToVisualLines,
  type BashToolDetails,
} from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { homedir as getHomedir } from "node:os";
import { resolve } from "node:path";

// ─── Schema ──────────────────────────────────────────────────────────────────

const bashWithCwdSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  cwd: Type.Optional(Type.String({
    description: "Working directory for this command. Prefer this over 'cd dir && command' — fails explicitly when the directory is missing.",
  })),
});

// ─── Extension ───────────────────────────────────────────────────────────────

export default function betterBashTool(pi: ExtensionAPI): void {
  const nativeDef = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...nativeDef,               // inherits name ("bash"), label
    description: "Execute a bash command in a specified or default working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Use the `cwd` parameter to set the working directory instead of 'cd dir && command'. Optionally provide a timeout in seconds.",
    parameters: bashWithCwdSchema,

    promptGuidelines: [
      "NEVER use 'cd dir && command' — always use the cwd parameter instead. 'cd dir && command' silently continues in wrong directory if cd fails; cwd parameter fails explicitly with a clear error.",
      "BAD: bash({command: 'cd /foo && npm install'}). GOOD: bash({command: 'npm install', cwd: '/foo'})",
      "BAD: bash({command: 'cd /repo && git status && cd /other && git log'}). GOOD: two separate bash calls each with the correct cwd parameter.",
      "Reserve bash for git, build/test runners, package managers, ssh, curl, and process management.",
      "Prefer native tools (read, find, grep, edit, write) over shell commands when available.",
    ],

    // 3-arg signature — _context unused, typed as unknown to avoid importing ToolRenderContext
    renderCall(args: { command?: string; timeout?: number; cwd?: string }, theme: Theme, _context: unknown) {
      const homedir = getHomedir();
      const command = typeof args.command === "string" ? args.command : "";
      const cmdLine = theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", command);
      const timeoutSuffix = args.timeout ? theme.fg("dim", ` (timeout ${args.timeout}s)`) : "";

      if (args.cwd && resolve(args.cwd) !== process.cwd()) {
        const displayCwd = args.cwd.startsWith(homedir)
          ? "~" + args.cwd.slice(homedir.length)
          : args.cwd;
        const cwdLine = theme.fg("muted", displayCwd);
        return new Text(cwdLine + "\n" + cmdLine + timeoutSuffix, 0, 0);
      }
      return new Text(cmdLine + timeoutSuffix, 0, 0);
    },

    // 4-arg signature — _context unused, typed as unknown
    renderResult(
      result: AgentToolResult<BashToolDetails | undefined>,
      options: ToolRenderResultOptions,
      theme: Theme,
      _context: unknown,
    ) {
      const box = new Box(0, 0);
      const output = getTextOutput(result).trim();
      const lineCount = output ? output.split("\n").length : 0;
      const exitMatch = output.match(/exit code: (\d+)/);
      const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;

      // Status line
      let statusText = "";
      if (exitCode === 0) {
        statusText = theme.fg("success", "✓");
      } else {
        statusText = theme.fg("error", `✗ exit ${exitCode}`);
      }
      statusText += theme.fg("dim", `  (${lineCount} lines)`);
      box.addChild(new Text(statusText, 0, 0));

      if (output) {
        if (options.expanded) {
          const lines = output.split("\n");
          const shownLines = lines.slice(0, 20);
          const styledShown = shownLines.map((line) => theme.fg("toolOutput", line)).join("\n");
          box.addChild(new Text("\n" + styledShown, 0, 0));
          if (lines.length > 20) {
            box.addChild(new Text("\n" + theme.fg("muted", `... (${lines.length - 20} more lines)`), 0, 0));
          }
        } else {
          // Collapsed: last 5 visual lines
          const styledOutput = output
            .split("\n")
            .map((line) => theme.fg("toolOutput", line))
            .join("\n");

          const cachedState: {
            width: number | undefined;
            lines: string[] | undefined;
            skipped: number | undefined;
          } = { width: undefined, lines: undefined, skipped: undefined };

          box.addChild({
            render: (width: number) => {
              if (cachedState.lines === undefined || cachedState.width !== width) {
                const preview = truncateToVisualLines(styledOutput, 5, width);
                cachedState.lines = preview.visualLines;
                cachedState.skipped = preview.skippedCount;
                cachedState.width = width;
              }
              if (cachedState.skipped && cachedState.skipped > 0) {
                const hint =
                  theme.fg("muted", `... (${cachedState.skipped} earlier lines,`) +
                  ` ${keyHint("app.tools.expand", "to expand")})`;
                return ["", truncateToWidth(hint, width, "..."), ...(cachedState.lines ?? [])];
              }
              return ["", ...(cachedState.lines ?? [])];
            },
            invalidate: () => {
              cachedState.width = undefined;
              cachedState.lines = undefined;
              cachedState.skipped = undefined;
            },
          });
        }
      }

      // Truncation/fullOutputPath warnings
      const details = result.details;
      const truncation = details?.truncation;
      const fullOutputPath = details?.fullOutputPath;
      if (truncation?.truncated || fullOutputPath) {
        const warnings: string[] = [];
        if (fullOutputPath) {
          warnings.push(`Full output: ${fullOutputPath}`);
        }
        if (truncation?.truncated) {
          if (truncation.truncatedBy === "lines") {
            warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
          } else {
            warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`);
          }
        }
        box.addChild(new Text("\n" + theme.fg("warning", `[${warnings.join(". ")}]`), 0, 0));
      }

      return box;
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const effectiveCwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      const bashForCwd = createBashToolDefinition(effectiveCwd);
      return bashForCwd.execute(
        toolCallId,
        { command: params.command, timeout: params.timeout },
        signal,
        onUpdate,
        ctx,
      );
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strips OSC/CSI/ANSI escapes and C0/C1 control chars (tab/LF/CR kept). */
function sanitizeShellOutput(value: string): string {
  return (
    value
      // OSC sequences: ESC ] ... (ST or BEL)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CSI sequences: ESC [ ... final byte
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      // Remaining ESC sequences
      .replace(/\x1b[^[\]]/g, "")
      // C0 control chars except tab (0x09), LF (0x0a), CR (0x0d)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      // C1 control chars
      .replace(/[\x80-\x9f]/g, "")
  );
}

/** Filters type:"text" blocks, sanitizes, joins, and trims. */
function getTextOutput(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => sanitizeShellOutput(block.text))
    .join("")
    .trim();
}
