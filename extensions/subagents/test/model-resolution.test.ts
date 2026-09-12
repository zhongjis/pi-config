import { expect, it } from "vitest";
import { resolveAgentModel } from "../src/model-resolution.js";

const opus = { provider: "anthropic", api: "anthropic-messages", id: "claude-opus-4-8", name: "Opus" };
const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4", name: "Codex" };
const registry = {
	getAvailable: () => [opus, codex], getAll: () => [opus, codex],
	find: (provider: string, id: string) => [opus, codex].find((model) => model.provider === provider && model.id === id),
	isUsingOAuth: () => false,
};

it("validates selected fast upfront without skipping unsupported candidate to a supported fallback", () => {
	expect(() => resolveAgentModel("openai-codex/gpt-5.4:fast,anthropic/claude-opus-4-8:fast", registry)).toThrow("Explicit :fast is unsupported");
});

it("selected fallback fast metadata is independent of unavailable candidates", () => {
	expect(resolveAgentModel("missing:fast,anthropic/claude-opus-4-8:low", registry)).toEqual({ model: opus, thinkingLevel: "low" });
	expect(resolveAgentModel("missing,anthropic/claude-opus-4-8:low:fast", registry)).toEqual({ model: opus, thinkingLevel: "low", fast: true });
});
