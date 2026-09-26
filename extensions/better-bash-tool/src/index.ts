import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Container, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolve } from "node:path";
import { renderToolCall, shortenHomePath } from "../../lib/index.js";

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

// ─── Command block ───────────────────────────────────────────────────────────

const COMMAND_PROMPT = "  $ ";
const COMMAND_HANG = " ".repeat(COMMAND_PROMPT.length);

/**
 * Presentation only — never affects the command string sent to the model.
 * The first line carries the "$ " prompt; wrapped and newline lines hang-indent
 * to the same column so a multi-line command reads as one unit.
 */
class CommandBlock implements Component {
  constructor(
    private readonly command: string,
    private readonly theme: Pick<Theme, "bold" | "fg">,
  ) {}

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 0;
    if (safeWidth === 0) return [];
    const contentWidth = Math.max(1, safeWidth - COMMAND_PROMPT.length);
    const lines: string[] = [];
    let promptEmitted = false;
    for (const logicalLine of this.command.split("\n")) {
      for (const segment of wrapTextWithAnsi(logicalLine, contentWidth)) {
        if (segment === "") {
          lines.push("");
          continue;
        }
        const prefix = promptEmitted ? COMMAND_HANG : COMMAND_PROMPT;
        promptEmitted = true;
        lines.push(this.theme.fg("accent", this.theme.bold(`${prefix}${segment}`)));
      }
    }
    return lines;
  }
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

      const command = typeof args.command === "string" ? args.command : "";
      const cwd = typeof args.cwd === "string" ? shortenHomePath(args.cwd) : undefined;
      const timeout = typeof args.timeout === "number" ? `timeout ${args.timeout}s` : undefined;
      const meta = [cwd, timeout].filter((part): part is string => Boolean(part)).join(" · ");

      // Header carries cwd (+ timeout); the command renders as its own
      // hanging-indent block so wrapped and multi-line commands line up under
      // the command text instead of dangling at the gutter. A metadata-free
      // single-line command stays inline on the header row.
      if (command && (meta !== "" || command.includes("\n"))) {
        const block = new Container();
        block.addChild(renderToolCall("bash", meta || undefined, theme));
        block.addChild(new CommandBlock(command, theme));
        return block;
      }

      const target = command ? theme.bold(`$ ${command}`) : meta || undefined;
      return renderToolCall("bash", target, theme);
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const effectiveCwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      // Native execute prefers ctx.cwd; spawnHook runs after that resolution.
      const bashForCwd = createBashToolDefinition(effectiveCwd, {
        spawnHook: (spawn) => ({ ...spawn, cwd: effectiveCwd }),
      });
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
