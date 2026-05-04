import { complete } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseModelChain, resolveModel as resolveSharedModel } from "../../lib/model.js";
import type { CapturedBatch, ContextPruneConfig, SummarizerThinking, SummarizeResult } from "./types.js";
import { serializeBatchForSummarizer, serializeBatchesForSummarizer } from "./batch-capture.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.`;

/** System prompt for batched summarization (multiple turns in one call). */
const BATCHED_SYSTEM_PROMPT = `You are summarizing multiple turns of tool calls made by an AI coding assistant.
For each turn, provide a concise summary of all tool calls in that turn:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Group by turn. Be concise.`;

type EffectiveSummarizerThinking = Exclude<SummarizerThinking, "default">;

interface ResolvedSummarizerModel {
  model: any;
  thinking?: EffectiveSummarizerThinking;
}

function effectiveSummarizerThinking(
  config: ContextPruneConfig,
  candidateThinking?: EffectiveSummarizerThinking,
): EffectiveSummarizerThinking | undefined {
  if (config.summarizerThinking !== "default") {
    return config.summarizerThinking;
  }
  return candidateThinking;
}

export function summarizerThinkingOptions(thinking?: EffectiveSummarizerThinking): Record<string, unknown> {
  if (thinking == null) {
    return {};
  }

  // complete() accepts provider-level options. For reasoning-capable providers,
  // pi-ai adapters translate reasoningEffort into the provider-specific field.
  // "off" intentionally sends no effort; adapters that support explicit disable
  // handle that the same way as an absent effort, while preserving compatibility.
  return { reasoningEffort: thinking === "off" ? undefined : thinking };
}

function isDefaultModelCandidate(model: string): boolean {
  return model === "default";
}

/**
 * Returns the model and effective thinking to use for summarization.
 * config.summarizerModel supports frontmatter-style fallback chains, e.g.
 * "claude-haiku-4-5:low,gemini-2.5-flash:off,default".
 * "default" means ctx.model, including as a fallback or with a suffix like "default:low".
 */
export function resolveSummarizerModel(
  config: ContextPruneConfig,
  ctx: ExtensionContext
): ResolvedSummarizerModel {
  const candidates = parseModelChain(config.summarizerModel);

  for (const candidate of candidates) {
    if (isDefaultModelCandidate(candidate.model)) {
      return {
        model: ctx.model,
        thinking: effectiveSummarizerThinking(config, candidate.thinkingLevel),
      };
    }

    const resolved = resolveSharedModel(candidate.model, ctx.modelRegistry);
    if (typeof resolved !== "string") {
      return {
        model: resolved,
        thinking: effectiveSummarizerThinking(config, candidate.thinkingLevel),
      };
    }
  }

  ctx.ui.notify(
    `pruner: no summarizerModel candidates resolved from "${config.summarizerModel}". Falling back to default model.`,
    "warning"
  );
  return { model: ctx.model, thinking: effectiveSummarizerThinking(config) };
}

/** Returns only the resolved summarizer model, preserving the old helper shape. */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  return resolveSummarizerModel(config, ctx).model;
}

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext
): Promise<SummarizeResult | null> {
  try {
    const { model, thinking } = resolveSummarizerModel(config, ctx);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`pruner: summarization failed: ${auth.error}`, "error");
      return null;
    }

    const serialized = serializeBatchForSummarizer(batch);
    const userMessage =
      SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";

    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers, ...summarizerThinkingOptions(thinking) }
    );

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    const toolCallIds = batch.toolCalls.map((tc) => tc.toolCallId);
    const idList = toolCallIds.map((id) => `\`${id}\``).join(", ");
    const footer =
      `\n\n---\n**Summarized toolCallIds**: ${idList}\n` +
      `Use \`context_tree_query\` with these IDs to retrieve the original full outputs.`;

    return {
      summaryText: llmText + footer,
      usage: response.usage,
    };
  } catch (err: any) {
    ctx.ui.notify(
      `pruner: summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}

/**
 * Summarizes multiple captured batches in a single LLM call.
 * Returns formatted markdown string, or null on failure.
 * On success, the footer lists ALL toolCallIds across all batches.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext
): Promise<SummarizeResult | null> {
  if (batches.length === 0) return null;
  // Single batch — delegate to the single-batch path for a simpler prompt
  if (batches.length === 1) return summarizeBatch(batches[0], config, ctx);

  try {
    const { model, thinking } = resolveSummarizerModel(config, ctx);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`pruner: summarization failed: ${auth.error}`, "error");
      return null;
    }

    const serialized = serializeBatchesForSummarizer(batches);
    const userMessage =
      BATCHED_SYSTEM_PROMPT + "\n\n<tool-call-batches>\n" + serialized + "\n</tool-call-batches>";

    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers, ...summarizerThinkingOptions(thinking) }
    );

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    // Collect ALL toolCallIds across all batches for the footer
    const allToolCallIds = batches.flatMap((b) => b.toolCalls.map((tc) => tc.toolCallId));
    const idList = allToolCallIds.map((id) => `\`${id}\``).join(", ");
    const footer =
      `\n\n---\n**Summarized toolCallIds**: ${idList}\n` +
      `Use \`context_tree_query\` with these IDs to retrieve the original full outputs.`;

    return {
      summaryText: llmText + footer,
      usage: response.usage,
    };
  } catch (err: any) {
    ctx.ui.notify(
      `pruner: batch summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}
