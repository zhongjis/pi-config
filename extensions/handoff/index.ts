import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getHandoffUsage,
  getPreparedHandoffCommand,
  parseHandoffArgs,
  parseHandoffFileArgs,
  registerDirectHandoffBridge,
  runHandoffCommand,
  runHandoffFileCommand,
  runPreparedHandoffCommand,
} from "./runtime.js";

export {
  buildPlanExecutionGoal,
  getHandoffFileUsage,
  getHandoffUsage,
  getPreparedHandoffCommand,
  parseHandoffArgs,
  parseHandoffFileArgs,
  registerDirectHandoffBridge,
  requestDirectHandoffBridge,
  runHandoffCommand,
  runHandoffFileCommand,
  runPreparedHandoffCommand,
  setPreparedHandoffArgsResolver,
  type DirectHandoffBridgeReply,
  type DirectHandoffBridgeRequest,
  type HandoffMode,
  type ParsedHandoffArgs,
  type ParsedHandoffFileArgs,
  type PreparedHandoffArgsResolver,
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

  pi.registerCommand("handoff:file", {
    description: "Write a handoff document to a temp file for another agent to pick up (-no-summarize)",
    handler: async (args: string, ctx: any) => {
      const parsed = parseHandoffFileArgs(args);
      const error = await runHandoffFileCommand(pi, ctx as ExtensionCommandContext, parsed);
      if (!error) {
        return;
      }

      const level = error === "Handoff cancelled." ? "info" : "error";
      ctx.ui.notify(error, level);
    },
  });

  pi.registerCommand("handoff:start-work", {
    description: `After planning mode finishes planning, run this to hand off the plan to an execution agent in a new session (${getPreparedHandoffCommand()})`,
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
