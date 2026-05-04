import { describe, expect, it, vi } from "vitest";
import type { ContextPruneConfig } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { resolveSummarizerModel, summarizerThinkingOptions } from "../src/summarizer.js";

const MODELS = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
];

const CURRENT_MODEL = { id: "current-model", name: "Current Model", provider: "mock" };

type ModelEntry = typeof MODELS[number] | typeof CURRENT_MODEL;

function config(overrides: Partial<ContextPruneConfig>): ContextPruneConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function makeContext(available: ModelEntry[] = MODELS): any {
  return {
    model: CURRENT_MODEL,
    modelRegistry: {
      find(provider: string, modelId: string) {
        return MODELS.find((model) => model.provider === provider && model.id === modelId);
      },
      getAll() {
        return MODELS;
      },
      getAvailable() {
        return available;
      },
    },
    ui: {
      notify: vi.fn(),
    },
  };
}

describe("resolveSummarizerModel", () => {
  it("uses the current model for default", () => {
    const ctx = makeContext();
    const resolved = resolveSummarizerModel(config({ summarizerModel: "default" }), ctx);

    expect(resolved).toEqual({ model: CURRENT_MODEL, thinking: undefined });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("resolves frontmatter-style fuzzy aliases with thinking suffixes", () => {
    const ctx = makeContext();
    const resolved = resolveSummarizerModel(
      config({ summarizerModel: "claude-haiku-4-5:low", summarizerThinking: "default" }),
      ctx,
    );

    expect(resolved).toEqual({ model: MODELS[1], thinking: "low" });
  });

  it("uses the first available candidate in a fallback chain", () => {
    const ctx = makeContext([MODELS[2]]);
    const resolved = resolveSummarizerModel(
      config({ summarizerModel: "sonnet:high,gemini-flash:off,default" }),
      ctx,
    );

    expect(resolved).toEqual({ model: MODELS[2], thinking: "off" });
  });

  it("supports default as a fallback candidate with candidate thinking", () => {
    const ctx = makeContext([]);
    const resolved = resolveSummarizerModel(
      config({ summarizerModel: "missing-model,default:low", summarizerThinking: "default" }),
      ctx,
    );

    expect(resolved).toEqual({ model: CURRENT_MODEL, thinking: "low" });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("lets summarizerThinking override candidate thinking", () => {
    const ctx = makeContext();
    const resolved = resolveSummarizerModel(
      config({ summarizerModel: "haiku:low", summarizerThinking: "medium" }),
      ctx,
    );

    expect(resolved).toEqual({ model: MODELS[1], thinking: "medium" });
  });

  it("warns and falls back to current model when no candidate resolves", () => {
    const ctx = makeContext([]);
    const resolved = resolveSummarizerModel(config({ summarizerModel: "missing-model" }), ctx);

    expect(resolved).toEqual({ model: CURRENT_MODEL, thinking: undefined });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'pruner: no summarizerModel candidates resolved from "missing-model". Falling back to default model.',
      "warning",
    );
  });
});

describe("summarizerThinkingOptions", () => {
  it("omits reasoning options when no thinking level is effective", () => {
    expect(summarizerThinkingOptions()).toEqual({});
  });

  it("passes provider reasoning effort for concrete thinking levels", () => {
    expect(summarizerThinkingOptions("low")).toEqual({ reasoningEffort: "low" });
  });

  it("keeps off compatible with existing provider adapters", () => {
    expect(summarizerThinkingOptions("off")).toEqual({ reasoningEffort: undefined });
  });
});
