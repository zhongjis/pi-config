import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  consumeHandoffStartupPrompt,
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

  // session_start fires on the NEW extension instance after ctx.newSession().
  // The old pi.sendUserMessage() routes to the disposed old AgentSession, so we
  // pass the prompt through globalThis and send it here with the valid new pi.
  pi.on("session_start", (event) => {
    if (event.reason !== "new") return;
    const prompt = consumeHandoffStartupPrompt();
    if (!prompt) return;
    setTimeout(() => pi.sendUserMessage(prompt), 0);
  });
}
