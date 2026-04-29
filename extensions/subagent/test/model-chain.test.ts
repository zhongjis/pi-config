import { describe, expect, it } from "vitest";
import { parseModelChain } from "../src/model-resolver.js";
import { isValidThinkingLevel } from "../src/thinking-level.js";

describe("parseModelChain", () => {
  it("parses a single model without thinking level", () => {
    expect(parseModelChain("sonnet")).toEqual([{ model: "sonnet" }]);
  });

  it("parses comma-separated models with thinking levels", () => {
    expect(parseModelChain("opus:high,sonnet:medium")).toEqual([
      { model: "opus", thinkingLevel: "high" },
      { model: "sonnet", thinkingLevel: "medium" },
    ]);
  });

  it("handles provider/model with thinking level (last colon wins)", () => {
    expect(parseModelChain("anthropic/claude-opus-4-6:high")).toEqual([
      { model: "anthropic/claude-opus-4-6", thinkingLevel: "high" },
    ]);
  });

  it("treats invalid thinking level suffix as part of model id", () => {
    expect(parseModelChain("openrouter/anthropic/claude-3.5-sonnet:exacto")).toEqual([
      { model: "openrouter/anthropic/claude-3.5-sonnet:exacto" },
    ]);
  });

  it("trims whitespace and skips empty segments", () => {
    expect(parseModelChain("model1 , model2:xhigh , ")).toEqual([
      { model: "model1" },
      { model: "model2", thinkingLevel: "xhigh" },
    ]);
  });
});

describe("isValidThinkingLevel", () => {
  it("returns true for valid thinking levels", () => {
    expect(isValidThinkingLevel("high")).toBe(true);
    expect(isValidThinkingLevel("off")).toBe(true);
  });

  it("returns false for invalid thinking levels", () => {
    expect(isValidThinkingLevel("exacto")).toBe(false);
  });
});
