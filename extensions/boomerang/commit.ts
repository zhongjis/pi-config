import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { parseModelChain, resolveFirstAvailable } from "../lib/model.js";

const COMMIT_MODEL_CHAIN = "gpt-5.4-mini,claude-haiku-4-5";
const COMMIT_MODEL_CANDIDATES = parseModelChain(COMMIT_MODEL_CHAIN);

export interface BoomerangTaskSnapshot {
  model?: Model<any>;
  thinking?: ThinkingLevel;
  forcedSkill?: string;
  targetModel?: Model<any>;
  targetThinking?: ThinkingLevel;
}

interface RegisterCommitCommandOptions {
  isBoomerangRunning(): boolean;
  setCommandContext(ctx: ExtensionCommandContext): void;
  startTask(
    task: string,
    ctx: ExtensionCommandContext,
    restoreSnapshot: BoomerangTaskSnapshot,
  ): Promise<void>;
}

export function buildCommitTask(args: string): string {
  const trimmedArgs = args.trim();
  return trimmedArgs ? `commit ${trimmedArgs}` : "commit";
}

export function registerCommitCommand(
  pi: ExtensionAPI,
  options: RegisterCommitCommandOptions,
): void {
  pi.registerCommand("boomerang:commit", {
    description: "Run git commit task through boomerang with git-master skill",
    handler: async (args, ctx) => {
      options.setCommandContext(ctx);

      if (options.isBoomerangRunning()) {
        ctx.ui.notify(
          "Boomerang already active. Use /boomerang-cancel to abort.",
          "error",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait for completion first.", "error");
        return;
      }

      const resolved = resolveFirstAvailable(
        COMMIT_MODEL_CANDIDATES,
        ctx.modelRegistry,
      );
      if (!resolved) {
        ctx.ui.notify(
          `No available model from: ${COMMIT_MODEL_CHAIN}`,
          "error",
        );
        return;
      }

      await options.startTask(buildCommitTask(args), ctx, {
        model: ctx.model,
        thinking: pi.getThinkingLevel(),
        forcedSkill: "git-master",
        targetModel: resolved.model,
        targetThinking: resolved.thinkingLevel,
      });
    },
  });
}
