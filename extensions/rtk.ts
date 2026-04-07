import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding, ExecFileSyncReturns } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLocalBashOperations, isToolCallEventType } from "@mariozechner/pi-coding-agent";

const REWRITE_TIMEOUT_MS = 5_000;
const NO_REWRITE_EXIT_CODE = 1;
const REWRITE_FOUND_EXIT_CODE = 3;

type ExecFileSyncError = Error & {
  status?: number | null;
  stdout?: ExecFileSyncReturns<ExecFileSyncOptionsWithStringEncoding>;
  stderr?: ExecFileSyncReturns<ExecFileSyncOptionsWithStringEncoding>;
  code?: string;
};

interface RewriteResult {
  command?: string;
  failure?: string;
}

function trimOutput(output: ExecFileSyncReturns<ExecFileSyncOptionsWithStringEncoding> | undefined): string {
  return typeof output === "string" ? output.trimEnd() : "";
}

function formatRewriteFailure(error: ExecFileSyncError): string {
  if (error.code === "ENOENT") {
    return "`rtk` is not installed or not on PATH";
  }

  if (error.code === "ETIMEDOUT") {
    return `rewrite timed out after ${REWRITE_TIMEOUT_MS}ms`;
  }

  if (typeof error.status === "number") {
    const stderr = trimOutput(error.stderr);
    return stderr ? `rewrite exited ${error.status}: ${stderr}` : `rewrite exited ${error.status}`;
  }

  return error.message || "unknown rewrite error";
}

function rtkRewriteCommand(command: string): RewriteResult {
  try {
    return {
      command: execFileSync("rtk", ["rewrite", command], {
        encoding: "utf-8",
        timeout: REWRITE_TIMEOUT_MS,
      }).trimEnd(),
    };
  } catch (error) {
    const execError = error as ExecFileSyncError;
    const stdout = trimOutput(execError.stdout);

    if (stdout && execError.status === REWRITE_FOUND_EXIT_CODE) {
      return { command: stdout };
    }

    if (!stdout && execError.status === NO_REWRITE_EXIT_CODE) {
      return {};
    }

    return { failure: formatRewriteFailure(execError) };
  }
}

export default function rtkExtension(pi: ExtensionAPI): void {
  let warnedAboutFailure = false;

  function warnRewriteFailureOnce(ctx: ExtensionContext, failure: string) {
    if (warnedAboutFailure || !ctx.hasUI) {
      return;
    }

    warnedAboutFailure = true;
    ctx.ui.notify(`RTK rewrite extension failed: ${failure}. Falling back to raw commands.`, "error");
  }
  // Rewrite bash tool commands before execution
  pi.on("tool_call", (_event, ctx) => {
    const event = _event;
    if (!isToolCallEventType("bash", event)) {
      return;
    }

    const rewrite = rtkRewriteCommand(event.input.command);
    if (rewrite.failure) {
      warnRewriteFailureOnce(ctx, rewrite.failure);
      return;
    }

    if (rewrite.command) {
      event.input.command = rewrite.command;
    }
  });

  // Rewrite user !cmd executions
  pi.on("user_bash", (event, ctx) => {
    if (event.excludeFromContext) {
      return;
    }

    if (typeof event.command !== "string") {
      return;
    }

    const rewrite = rtkRewriteCommand(event.command);
    if (rewrite.failure) {
      warnRewriteFailureOnce(ctx, rewrite.failure);
      return;
    }

    const rewrittenCommand = rewrite.command;
    if (!rewrittenCommand) {
      return;
    }

    const local = createLocalBashOperations();
    return {
      operations: {
        exec(_command, cwd, options) {
          return local.exec(rewrittenCommand, cwd, options);
        },
      },
    };
  });
}
