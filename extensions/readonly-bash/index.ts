import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BashToolDetails,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createBashToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export const DEFAULT_READONLY_BASH_TIMEOUT_SECONDS = 30;

const readonlyBashSchema = Type.Object({
  command: Type.String({ description: "Restricted read-only shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: `Kill command after this many seconds (default ${DEFAULT_READONLY_BASH_TIMEOUT_SECONDS})`,
    }),
  ),
});

export type ValidationResult =
  | { ok: true; command: string; argv: string[] }
  | { ok: false; reason: string };

const ALLOWED_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "fd",
  "rg",
  "grep",
  "cat",
  "head",
  "tail",
  "sed",
  "awk",
  "jq",
  "wc",
  "sort",
  "uniq",
  "cut",
  "file",
  "stat",
  "du",
  "df",
  "git",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
  "grep",
]);

const MUTABLE_GIT_SUBCOMMANDS = new Set([
  "add",
  "checkout",
  "switch",
  "restore",
  "reset",
  "clean",
  "commit",
  "merge",
  "rebase",
  "pull",
  "push",
  "fetch",
  "tag",
  "remote",
]);

const MUTATING_FIND_ACTIONS = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

const MUTATING_GIT_BRANCH_OPTIONS = new Set([
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
]);

const GIT_OUTPUT_OPTIONS = new Set(["--output"]);

const MUTATING_COMMANDS = new Set([
  "rm",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "rmdir",
  "chmod",
  "chown",
  "ln",
  "vi",
  "vim",
  "nvim",
  "nano",
  "emacs",
  "ed",
  "code",
  "sudo",
  "eval",
  "source",
  "xargs",
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "deno",
  "lua",
  "systemctl",
  "service",
  "launchctl",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

function commandName(token: string): string {
  const withoutPath = token.split("/").pop() ?? token;
  return withoutPath.toLowerCase();
}

function hasControlCharacter(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

function findRejectedShellSyntax(command: string): string | undefined {
  let quote: "single" | "double" | undefined;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1];

    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
        continue;
      }
      if (char === "`") return "command substitution is not allowed";
      if (char === "$") return "parameter or command substitution is not allowed";
      continue;
    }

    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }

    if (char === "|") return "pipes and command chaining are not allowed";
    if (char === ";") return "command chaining is not allowed";
    if (char === "&") return "backgrounding and command chaining are not allowed";
    if (char === ">" || char === "<") return "redirection is not allowed";
    if (char === "`") return "command substitution is not allowed";
    if (char === "$" && (next === "(" || next === "{")) {
      return "parameter or command substitution is not allowed";
    }
    if (char === "\\") return "shell escapes are not allowed";
  }

  if (quote) return "unterminated quote";
  return undefined;
}

export function tokenizeReadonlyBashCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (quote === "single") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }

    if (quote === "double") {
      if (char === '"') quote = undefined;
      else current += char;
      continue;
    }

    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function validateFind(argv: string[]): string | undefined {
  const args = argv.slice(1).map((arg) => arg.toLowerCase());
  if (args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg))) {
    return "find command execution actions are not allowed";
  }
  if (args.some((arg) => MUTATING_FIND_ACTIONS.has(arg))) {
    return "find output or mutation actions are not allowed";
  }
  return undefined;
}

function sedScriptHasWriteCommand(script: string): boolean {
  const address = String.raw`(?:\d+|\$|/[^/]*(?:\.[^/]*)*/)`;
  const addressRange = String.raw`(?:${address}(?:\s*,\s*${address})?)?`;
  const writeCommand = new RegExp(String.raw`(^|[;{}\n])\s*${addressRange}\s*!?\s*w(?:\s|$)`);
  const substituteWithWriteFlag = /(^|[;{}\s])s([^A-Za-z0-9\s]).*\2w(?:\s|$)/;
  return writeCommand.test(script) || substituteWithWriteFlag.test(script);
}

function sedScriptHasShellExecutionCommand(script: string): boolean {
  const address = String.raw`(?:\d+|\$|/[^/]*(?:\.[^/]*)*/)`;
  const addressRange = String.raw`(?:${address}(?:\s*,\s*${address})?)?`;
  const execCommand = new RegExp(String.raw`(^|[;{}\n])\s*${addressRange}\s*!?\s*e(?:\s|$)`);
  const substituteWithExecFlag = /(^|[;{}\s])s([^A-Za-z0-9\s]).*\2[^;{}\s]*e[^;{}\s]*(?:[;{}\s]|$)/;
  return execCommand.test(script) || substituteWithExecFlag.test(script);
}

function isSedInPlaceOption(arg: string): boolean {
  if (arg === "--in-place" || arg.startsWith("--in-place=")) return true;
  if (!arg.startsWith("-") || arg.startsWith("--")) return false;
  if (arg === "-i" || arg.startsWith("-i")) return true;

  const optionGroup = arg.slice(1);
  return /^[A-Za-z]+$/.test(optionGroup) && optionGroup.includes("n") && optionGroup.includes("i");
}

function sedScripts(argv: string[]): { scripts: string[]; rejectedReason?: string } {
  const scripts: string[] = [];
  let foundImplicitScript = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-e" || arg === "--expression") {
      const script = argv[i + 1];
      if (script) scripts.push(script);
      foundImplicitScript = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("-e") && arg.length > 2) {
      scripts.push(arg.slice(2));
      foundImplicitScript = true;
      continue;
    }
    if (
      arg === "-f" ||
      arg === "--file" ||
      arg.startsWith("--file=") ||
      (arg.startsWith("-f") && arg.length > 2)
    ) {
      return { scripts, rejectedReason: "sed script files are not allowed" };
    }
    if (arg.startsWith("-")) continue;
    if (!foundImplicitScript) {
      scripts.push(arg);
      foundImplicitScript = true;
    }
  }
  return { scripts };
}

function validateSed(argv: string[]): string | undefined {
  const args = argv.slice(1);
  const hasNoPrint = args.some((arg) => /^-[A-Za-z]*n[A-Za-z]*$/.test(arg));
  if (!hasNoPrint) return "sed requires -n for read-only use";
  if (args.some(isSedInPlaceOption)) {
    return "sed in-place editing is not allowed";
  }

  const { scripts, rejectedReason } = sedScripts(argv);
  if (rejectedReason) return rejectedReason;
  if (scripts.some(sedScriptHasWriteCommand)) {
    return "sed write commands are not allowed";
  }
  if (scripts.some(sedScriptHasShellExecutionCommand)) {
    return "sed shell execution commands are not allowed";
  }
  return undefined;
}

function validateAwk(argv: string[]): string | undefined {
  const args = argv.slice(1);
  if (args.some((arg) => arg.includes(">") || arg.includes("|"))) {
    return "awk output redirection is not allowed";
  }
  if (args.some((arg) => /\b(system|fflush)\s*\(/.test(arg) || /\bgetline\b.*<|<.*\bgetline\b/.test(arg))) {
    return "awk side-effecting operations are not allowed";
  }
  return undefined;
}

function gitOptionMatches(arg: string, options: Set<string>): boolean {
  return options.has(arg) || [...options].some((option) => arg.startsWith(`${option}=`));
}

function validateGit(argv: string[]): string | undefined {
  const subcommand = argv[1]?.toLowerCase();
  if (!subcommand) return "git requires an explicit read-only subcommand";
  if (MUTABLE_GIT_SUBCOMMANDS.has(subcommand)) {
    return `git ${subcommand} is not allowed`;
  }
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return `git ${subcommand} is outside the read-only allowlist`;
  }
  const args = argv.slice(2);
  if (subcommand === "branch" && args.some((arg) => gitOptionMatches(arg, MUTATING_GIT_BRANCH_OPTIONS))) {
    return "git branch mutation options are not allowed";
  }
  if (["diff", "show"].includes(subcommand) && args.some((arg) => gitOptionMatches(arg, GIT_OUTPUT_OPTIONS))) {
    return `git ${subcommand} output options are not allowed`;
  }
  return undefined;
}

function validateNixOrNh(argv: string[]): string | undefined {
  const name = commandName(argv[0] ?? "");
  const subcommand = argv[1]?.toLowerCase();
  if (name === "nix" && ["build", "develop", "run"].includes(subcommand ?? "")) {
    return `nix ${subcommand} is not allowed`;
  }
  if (name === "nh" && subcommand === "os" && argv[2]?.toLowerCase() === "switch") {
    return "nh os switch is not allowed";
  }
  return undefined;
}

function validateAllowedFamily(argv: string[]): string | undefined {
  const name = commandName(argv[0] ?? "");

  if (PACKAGE_MANAGERS.has(name)) return `${name} package-manager commands are not allowed`;
  const nixOrNhReason = validateNixOrNh(argv);
  if (nixOrNhReason) return nixOrNhReason;
  if (name === ".") return "shell sourcing is not allowed";
  if (MUTATING_COMMANDS.has(name)) return `${name} is not allowed`;
  if (!ALLOWED_COMMANDS.has(name)) return `${name || "command"} is outside the read-only allowlist`;

  if (name === "find") return validateFind(argv);
  if (name === "sed") return validateSed(argv);
  if (name === "awk") return validateAwk(argv);
  if (name === "git") return validateGit(argv);
  return undefined;
}

export function validateReadonlyBashCommand(command: string): ValidationResult {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "command is empty" };
  if (hasControlCharacter(command)) {
    return { ok: false, reason: "newlines and control characters are not allowed" };
  }

  const syntaxReason = findRejectedShellSyntax(trimmed);
  if (syntaxReason) return { ok: false, reason: syntaxReason };

  const argv = tokenizeReadonlyBashCommand(trimmed);
  const familyReason = validateAllowedFamily(argv);
  if (familyReason) return { ok: false, reason: familyReason };

  return { ok: true, command: trimmed, argv };
}

export function assertReadonlyBashCommand(command: string): { command: string; argv: string[] } {
  const result = validateReadonlyBashCommand(command);
  if (result.ok === false) throw new Error(`readonly_bash blocked: ${result.reason}`);
  return { command: result.command, argv: result.argv };
}

type ReadonlyBashDetails = Record<string, unknown> & {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type ReadonlyBashResult = AgentToolResult<ReadonlyBashDetails>;
type BashResult = AgentToolResult<BashToolDetails | undefined>;
type ReadonlyBashTool = {
  name: string;
  label: string;
  description: string;
  parameters: typeof readonlyBashSchema;
  execute(
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<ReadonlyBashDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<ReadonlyBashResult>;
};

type ReadonlyBashRegistrar = {
  registerTool(tool: ReadonlyBashTool): void;
};

function textContent(result: Pick<AgentToolResult<unknown>, "content">): string {
  return result.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function normalizeResult(result: BashResult, exitCode: number): ReadonlyBashResult {
  const stdout = textContent(result);
  return {
    ...result,
    details: {
      ...(result.details ?? {}),
      stdout: stdout === "(no output)" ? "" : stdout,
      stderr: "",
      exitCode,
    },
  };
}

function commandExitFromError(error: unknown): { output: string; exitCode: number } | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = error.message.match(/\n\nCommand exited with code (\d+)$/);
  if (!match) return undefined;
  return {
    output: error.message.slice(0, match.index),
    exitCode: Number(match[1]),
  };
}

export default function readonlyBash(pi: ReadonlyBashRegistrar): void {
  const readonlyBashTool: ReadonlyBashTool = {
    name: "readonly_bash",
    label: "readonly_bash",
    description:
      "Execute a restricted read-only shell command from the current working directory. This is a best-effort accidental-mutation guard, not a security sandbox.",
    parameters: readonlyBashSchema,

    async execute(
      toolCallId: string,
      params: { command: string; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ReadonlyBashDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<ReadonlyBashResult> {
      const validation = assertReadonlyBashCommand(params.command);
      const timeout = params.timeout ?? DEFAULT_READONLY_BASH_TIMEOUT_SECONDS;
      const bash = createBashToolDefinition(ctx.cwd);
      const onBashUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined = onUpdate
        ? (partialResult) => onUpdate(normalizeResult(partialResult, 0))
        : undefined;

      try {
        const result = await bash.execute(
          toolCallId,
          { command: validation.command, timeout },
          signal,
          onBashUpdate,
          ctx,
        );
        return normalizeResult(result, 0);
      } catch (error) {
        const commandExit = commandExitFromError(error);
        if (!commandExit) throw error;
        return normalizeResult(
          {
            content: [{ type: "text", text: commandExit.output || "(no output)" }],
            details: undefined,
          },
          commandExit.exitCode,
        );
      }
    },
  };

  pi.registerTool(readonlyBashTool);
}
