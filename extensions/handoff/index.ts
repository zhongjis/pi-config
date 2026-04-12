import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  getHandoffUsage,
  getPreparedHandoffCommand,
  parseHandoffArgs,
  registerDirectHandoffBridge,
  runHandoffCommand,
  runPreparedHandoffCommand,
} from "./runtime.js";

export {
  buildPlanExecutionGoal,
  getHandoffUsage,
  getPreparedHandoffCommand,
  parseHandoffArgs,
  registerDirectHandoffBridge,
  requestDirectHandoffBridge,
  runHandoffCommand,
  runPreparedHandoffCommand,
  type DirectHandoffBridgeReply,
  type DirectHandoffBridgeRequest,
  type HandoffMode,
  type ParsedHandoffArgs,
} from "./runtime.js";

export default function (pi: ExtensionAPI) {
  const unsubscribeBridge = registerDirectHandoffBridge(pi);

  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session (-mode <name>, -no-summarize)",
    handler: async (args: string, ctx: any) => {
      const parsed = parseHandoffArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error || getHandoffUsage(), "error");
        return;
      }

      const error = await runHandoffCommand(pi, ctx as ExtensionCommandContext, parsed.value);
      if (!error) {
        return;
      }

      const level = error === "Handoff cancelled." || error === "New session cancelled." ? "info" : "error";
      ctx.ui.notify(error, level);
    },
  });

  pi.registerCommand("handoff:continue", {
    description: `Start prepared handoff for current session (${getPreparedHandoffCommand()})`,
    handler: async (_args: string, ctx: any) => {
      const error = await runPreparedHandoffCommand(pi, ctx as ExtensionCommandContext);
      if (!error) {
        return;
      }

      const level = error === "Handoff cancelled." || error === "New session cancelled." ? "info" : "error";
      ctx.ui.notify(error, level);
    },
  });

  pi.on("session_shutdown", () => {
    unsubscribeBridge();
  });
}
