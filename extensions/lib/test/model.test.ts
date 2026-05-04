import { describe, expect, it } from "vitest";
import { parseModelChain, resolveFirstAvailable, type ModelRegistry } from "../model.js";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
];

function makeRegistry(available = MODELS): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return MODELS.find((model) => model.provider === provider && model.id === modelId);
    },
    getAll() {
      return MODELS;
    },
    getAvailable() {
      return available;
    },
  };
}

describe("parseModelChain", () => {
  it("parses comma-separated fallback candidates with thinking suffixes", () => {
    expect(parseModelChain("claude-haiku-4-5:low, gemini-2.5-flash:off, default")).toEqual([
      { model: "claude-haiku-4-5", thinkingLevel: "low" },
      { model: "gemini-2.5-flash", thinkingLevel: "off" },
      { model: "default" },
    ]);
  });

  it("keeps unknown colon suffixes as part of the model string", () => {
    expect(parseModelChain("provider/model:turbo")).toEqual([{ model: "provider/model:turbo" }]);
  });
});

describe("resolveFirstAvailable", () => {
  it("returns the first candidate that resolves against available models", () => {
    const resolved = resolveFirstAvailable(
      parseModelChain("missing:high, gemini-flash:off, haiku:low"),
      makeRegistry([MODELS[1]]),
    );

    expect(resolved).toEqual({ model: MODELS[1], thinkingLevel: "off" });
  });

  it("returns undefined when no candidate resolves", () => {
    expect(resolveFirstAvailable(parseModelChain("missing"), makeRegistry([]))).toBeUndefined();
  });
});
