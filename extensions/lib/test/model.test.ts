import { describe, expect, it } from "vitest";
import { parseModelChain, resolveFirstAvailable, resolveModel, type ModelRegistry } from "../model.js";

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

  it("handles available model entries without names", () => {
    const nameless = { id: "gemini-2.5-flash", provider: "google" };
    const registry: ModelRegistry = {
      find(provider: string, modelId: string) {
        return provider === nameless.provider && modelId === nameless.id ? nameless : undefined;
      },
      getAll() {
        return [nameless];
      },
      getAvailable() {
        return [nameless];
      },
    };

    expect(resolveFirstAvailable(parseModelChain("gemini-flash"), registry)).toEqual({
      model: nameless,
      thinkingLevel: undefined,
    });
  });
});

describe("resolveModel", () => {
	const RM = [
		{ id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
		{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
		{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
		{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
	];
	function reg(models = RM, available?: typeof RM): ModelRegistry {
		return {
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
			getAll: () => models,
			getAvailable: available ? () => available : undefined,
		};
	}

	it("resolves exact provider/modelId", () => {
		expect(resolveModel("anthropic/claude-opus-4-6", reg())).toEqual(RM[0]);
	});
	it("resolves a bare exact id and is case-insensitive", () => {
		expect(resolveModel("gpt-4o", reg())).toEqual(RM[3]);
		expect(resolveModel("Claude-Opus-4-6", reg())).toEqual(RM[0]);
	});
	it("substring-matches bare tokens", () => {
		expect(resolveModel("haiku", reg())).toEqual(RM[2]);
		expect(resolveModel("sonnet", reg())).toEqual(RM[1]);
	});
	it("matches a dotted query to a dashed id (normalize)", () => {
		const HAIKU = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
		expect(resolveModel("claude-haiku-4.5", reg([HAIKU]))).toEqual(HAIKU);
	});
	it("matches a dotted provider/id query to a dashed id (normalize)", () => {
		const HAIKU = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
		expect(resolveModel("anthropic/claude-haiku-4.5", reg([HAIKU]))).toEqual(HAIKU);
	});
	it("matches a dated provider/id config to an undated registry id (datestamp optional)", () => {
		const HAIKU = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
		expect(resolveModel("anthropic/claude-haiku-4-5-20251001", reg([HAIKU]))).toEqual(HAIKU);
	});
	it("still prefers an exact dated id when the registry has it", () => {
		const dated = { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" };
		expect(resolveModel("anthropic/claude-haiku-4-5-20251001", reg([dated]))).toEqual(dated);
	});
	it("does NOT vacuously match a datestamp-only query", () => {
		expect(typeof resolveModel("20251001", reg())).toBe("string");
	});
	it("prefers the named provider when it has the model", () => {
		const gw = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "openrouter" };
		const an = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
		expect(resolveModel("anthropic/claude-haiku-4-5", reg([gw, an]))).toEqual(an);
	});
	it("FAILS faithfully when the named provider lacks the model (no cross-provider)", () => {
		const gw = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "openrouter" };
		expect(typeof resolveModel("anthropic/claude-haiku-4-5", reg([gw]))).toBe("string");
	});
	it("uses preferProviders to break bare-id ties", () => {
		const gw = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "openrouter" };
		const an = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
		expect(resolveModel("claude-haiku-4-5", reg([gw, an]), ["anthropic", "openrouter"])).toEqual(an);
		expect(resolveModel("claude-haiku-4-5", reg([gw, an]), ["openrouter", "anthropic"])).toEqual(gw);
	});
	it("does not fuzzy-match a model absent from getAvailable", () => {
		expect(typeof resolveModel("sonnet", reg(RM, [RM[0], RM[2]]))).toBe("string");
	});
	it("returns an error string listing models on no match", () => {
		const r = resolveModel("nonexistent-model", reg());
		expect(typeof r).toBe("string");
		expect(r).toContain('Model not found: "nonexistent-model"');
	});
});
