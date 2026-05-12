import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { createBashToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { homedir as getHomedir } from "node:os";
import { resolve } from "node:path";

// ─── Schema ──────────────────────────────────────────────────────────────────

const bashWithCwdSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute. MUST NOT start with 'cd'. Use cwd parameter instead." }),
  timeout: Type.Optional(
    Type.Number({
      description: "Kill command after this many seconds (no default)",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for this command. ALWAYS set this instead of using 'cd' in the command. Resolves relative paths against context cwd. Fails explicitly if directory is missing.",
    }),
  ),
});

type NativeBashTimingContext = {
  executionStarted?: boolean;
  state?: {
    startedAt?: number;
    endedAt?: number;
  };
};

function markNativeBashTiming(context: unknown): void {
  if (!context || typeof context !== "object") return;
  const renderContext = context as NativeBashTimingContext;
  if (!renderContext.executionStarted || !renderContext.state) return;
  if (renderContext.state.startedAt !== undefined) return;

  renderContext.state.startedAt = Date.now();
  renderContext.state.endedAt = undefined;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function betterBashTool(pi: ExtensionAPI): void {
  const nativeDef = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...nativeDef, // inherits name ("bash"), label, native streaming renderResult
    description:
      "Execute a bash command in a directory. ALWAYS use `cwd` to set the working directory — NEVER use `cd dir && command` in the command string. Returns stdout and stderr, truncated to last 2000 lines or 50KB. Set `timeout` in seconds to limit execution time.",
    parameters: bashWithCwdSchema,

    promptGuidelines: [
      "CRITICAL: NEVER write `cd /path && command` or `cd /path; command`. ALWAYS pass the directory as `cwd` and write only the command. This applies to ALL commands including git, npm, make, etc.",
      "GOOD: bash({command: 'git log --oneline', cwd: '/repo'}).  BAD: bash({command: 'cd /repo && git log --oneline'}).",
      "GOOD: bash({command: 'git diff HEAD~1', cwd: '/repo'}).  BAD: bash({command: 'cd /repo && git diff HEAD~1'}).",
      "`cwd` is safer than `cd`: `cd` silently continues in the wrong directory on failure; `cwd` fails explicitly with a clear error.",
      "For commands in multiple directories, use separate bash calls each with its own `cwd`.",
      "Prefer native tools (read, edit, write) over bash equivalents when available. Reserve bash for: git, build/test runners, package managers, ssh, curl, and process management.",
    ],

    // 3-arg signature — context is only used to seed native bash timing state.
    renderCall(
      args: { command?: string; timeout?: number; cwd?: string },
      theme: Theme,
      context: unknown,
    ) {
      markNativeBashTiming(context);

      const homedir = getHomedir();
      const command = typeof args.command === "string" ? args.command : "";
      const cmdLine =
        theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", command);
      const timeoutSuffix = args.timeout
        ? theme.fg("dim", ` (timeout ${args.timeout}s)`)
        : "";

      if (args.cwd) {
        const displayCwd = args.cwd.startsWith(homedir)
          ? "~" + args.cwd.slice(homedir.length)
          : args.cwd;
        const cwdLine = theme.fg("muted", displayCwd);
        return new Text(cwdLine + "\n" + cmdLine + timeoutSuffix, 0, 0);
      }
      return new Text(cmdLine + timeoutSuffix, 0, 0);
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
