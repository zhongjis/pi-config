import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLocalBashOperations, isToolCallEventType } from "@mariozechner/pi-coding-agent";

const REWRITE_TIMEOUT_MS = 5_000;

function rtkRewriteCommand(command: string): string | undefined {
  try {
    return execFileSync("rtk", ["rewrite", command], {
      encoding: "utf-8",
      timeout: REWRITE_TIMEOUT_MS,
    }).trimEnd();
  } catch {
    return undefined;
  }
}

export default function rtkExtension(pi: ExtensionAPI): void {
  // Rewrite bash tool commands before execution
  pi.on("tool_call", (_event, _ctx) => {
    const event = _event;
    if (!isToolCallEventType("bash", event)) {
      return;
    }

    const rewritten = rtkRewriteCommand(event.input.command);
    if (rewritten) {
      event.input.command = rewritten;
    }
  });

  // Rewrite user !cmd executions
  pi.on("user_bash", (event, _ctx) => {
    if (event.excludeFromContext) {
      return;
    }

    if (typeof event.command !== "string") {
      return;
    }

    // Only intercept when RTK can actually rewrite the command
    const rewritten = rtkRewriteCommand(event.command);
    if (!rewritten) {
      return;
    }

    const local = createLocalBashOperations();
    return {
      operations: {
        exec(command, cwd, options) {
          // command arg here is already the raw user command;
          // use our pre-computed rewritten version instead
          const finalCommand = rtkRewriteCommand(command) ?? command;
          return local.exec(finalCommand, cwd, options);
        },
      },
    };
  });
}
