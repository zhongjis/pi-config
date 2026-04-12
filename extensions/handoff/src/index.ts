import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getHandoffUsage, maybeSendPendingHandoff, parseHandoffArgs, runHandoffCommand } from "./runtime.js";

export { buildPlanExecutionGoal, getHandoffUsage, parseHandoffArgs, runHandoffCommand, type HandoffMode, type ParsedHandoffArgs } from "./runtime.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session (-mode <name>, -no-summarize)",
    handler: async (args: string, ctx: any) => {
      const parsed = parseHandoffArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error || getHandoffUsage(), "error");
        return;
      }

      const error = await runHandoffCommand(ctx as ExtensionCommandContext, parsed.value);
      if (!error) {
        return;
      }

      const level = error === "Handoff cancelled." || error === "New session cancelled." ? "info" : "error";
      ctx.ui.notify(error, level);
    },
  });

  pi.on("session_start", async (event: any) => {
    maybeSendPendingHandoff(pi, event as { reason?: string });
  });
}
