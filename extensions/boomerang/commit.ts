import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../lib/model.js";
import type { ModelCandidate, ModelRegistry } from "../lib/model.js";
import { getToolModelSelection, loadToolModelsConfig } from "../lib/tool-models.js";

const COMMIT_TOOL_KEY = "boomerang.commit";

// Pi triggers auto-compaction when context tokens exceed
// (contextWindow - reserveTokens). Switching the commit task to a model whose
// window cannot hold the current context would immediately trip compaction on
// the user's main session, so a candidate is only eligible if it can hold the
// current context plus this reserve.
const COMMIT_CONTEXT_RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
const DEFAULT_CONTEXT_WINDOW = 128000;

type CommitModelResolution = {
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  reason?: "unavailable" | "context-too-large";
};

// Resolve the first available commit model whose context window can hold the
// current context. When requiredTokens is null (usage unknown), the window
// check is skipped and resolution matches plain first-available behavior.
function resolveCommitModel(
  candidates: ModelCandidate[],
  registry: ModelRegistry,
  requiredTokens: number | null,
): CommitModelResolution {
  let sawAvailableButTooSmall = false;
  for (const candidate of candidates) {
    const result = resolveModel(candidate.model, registry);
    if (typeof result === "string") continue; // unavailable / no auth
    if (requiredTokens !== null) {
      const window = result.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      if (window < requiredTokens) {
        sawAvailableButTooSmall = true;
        continue;
      }
    }
    return { model: result, thinkingLevel: candidate.thinkingLevel };
  }
  return { reason: sawAvailableButTooSmall ? "context-too-large" : "unavailable" };
}

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

      const usage = ctx.getContextUsage?.();
      const requiredTokens =
        usage && usage.tokens !== null
          ? usage.tokens + COMMIT_CONTEXT_RESERVE_TOKENS
          : null;

      const toolModelConfig = loadToolModelsConfig(ctx.cwd);
      const selection = getToolModelSelection(toolModelConfig, COMMIT_TOOL_KEY);
      const resolved = resolveCommitModel(
        selection?.candidates ?? [],
        ctx.modelRegistry,
        requiredTokens,
      );
      if (!resolved.model) {
        const current = `${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`;
        if (resolved.reason === "context-too-large") {
          ctx.ui.notify(
            `Current context (~${usage?.tokens ?? "?"} tokens) exceeds every commit model's context window. Using current model (${current}) to avoid compaction.`,
            "warning",
          );
        } else {
          ctx.ui.notify(
            `No commit-specific model available from: ${selection?.chain ?? "none"}. Falling back to current model (${current}).`,
            "warning",
          );
        }
      }

      await options.startTask(buildCommitTask(args), ctx, {
        model: ctx.model,
        thinking: pi.getThinkingLevel(),
        forcedSkill: "git-master",
        targetModel: resolved.model ?? ctx.model,
        targetThinking: resolved.thinkingLevel,
      });
    },
  });
}
