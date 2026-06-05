import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { parseModelChain, resolveFirstAvailable } from "../lib/model.js";

// Profile-aware chain: one entry per active profile (default/opencode/local).
// resolveFirstAvailable picks the first one in the registry that's already
// filtered by the active profile via getAvailable().
const COMMIT_MODEL_CHAIN = [
  "gpt-5.4-mini",
  "claude-haiku-4-5",
  "opencode-go/qwen3.5-plus",
  "llama-swap/qwen2.5-coder:7b",
].join(",");
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
          `No commit-specific model available from: ${COMMIT_MODEL_CHAIN}. Falling back to current model (${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}).`,
          "warning",
        );
      }

      await options.startTask(buildCommitTask(args), ctx, {
        model: ctx.model,
        thinking: pi.getThinkingLevel(),
        forcedSkill: "git-master",
        targetModel: resolved?.model ?? ctx.model,
        targetThinking: resolved?.thinkingLevel,
      });
    },
  });
}
