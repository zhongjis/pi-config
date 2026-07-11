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
import { MODE_META, MODES } from "../modes/src/constants.js";

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

const HANDOFF_MODE_COMPLETIONS = MODES.map((mode) => ({
  value: mode,
  label: MODE_META[mode].label,
}));

export default function (pi: ExtensionAPI) {
  const unsubscribeBridge = registerDirectHandoffBridge(pi);

  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session (-mode <name>, -no-summarize)",
    argumentHint: "[-mode <mode>] [-no-summarize] <content>",
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
  } as Parameters<typeof pi.registerCommand>[1] & { argumentHint: string });

  pi.registerCommand("handoff:mode", {
    description: "Transfer context to a new focused session in the specified mode",
    argumentHint: "<mode> <content>",
    getArgumentCompletions: (prefix: string) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      if (normalizedPrefix.includes(" ")) return null;
      const matches = HANDOFF_MODE_COMPLETIONS.filter(({ value }) => value.startsWith(normalizedPrefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args: string, ctx: any) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /handoff:mode <mode> <content>", "error");
        return;
      }

      const parsed = parseHandoffArgs(`-mode ${args}`);
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
  } as Parameters<typeof pi.registerCommand>[1] & { argumentHint: string });

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
