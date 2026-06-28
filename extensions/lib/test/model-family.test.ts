import { describe, expect, it } from "vitest";
import {
	extractModelId,
	isGptModel,
	isGeminiModel,
	getModePromptSource,
} from "../model-family.js";

describe("extractModelId", () => {
	it("returns lowercase id", () => {
		expect(extractModelId({ provider: "openai", id: "GPT-5.5" })).toBe("gpt-5.5");
	});

	it("handles lowercase id unchanged", () => {
		expect(extractModelId({ provider: "openai", id: "gpt-5.5" })).toBe("gpt-5.5");
	});
});

describe("isGptModel", () => {
	it("returns true when id contains 'gpt'", () => {
		expect(isGptModel({ provider: "openai", id: "gpt-5.5" })).toBe(true);
	});

	it("returns true for proxy providers with gpt in id", () => {
		expect(isGptModel({ provider: "litellm", id: "gpt-5.4" })).toBe(true);
		expect(isGptModel({ provider: "openai-codex", id: "gpt-5.5" })).toBe(true);
		expect(isGptModel({ provider: "vercel", id: "gpt-5.5" })).toBe(true);
	});

	it("returns false when id does not contain 'gpt'", () => {
		expect(isGptModel({ provider: "anthropic", id: "claude-opus-4-8" })).toBe(false);
		expect(isGptModel({ provider: "google", id: "gemini-3.1-pro" })).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(isGptModel({ provider: "openai", id: "GPT-5.5" })).toBe(true);
	});
});

describe("isGeminiModel", () => {
	it("returns true when provider starts with 'google'", () => {
		expect(isGeminiModel({ provider: "google", id: "gemini-3.1-pro" })).toBe(true);
	});

	it("returns true when provider is 'google-vertex'", () => {
		expect(isGeminiModel({ provider: "google-vertex", id: "gemini-3-flash" })).toBe(true);
	});

	it("returns true when id contains 'gemini'", () => {
		expect(isGeminiModel({ provider: "some-proxy", id: "gemini-3.1-pro" })).toBe(true);
	});

	it("returns true when provider is google even if id does not contain gemini", () => {
		expect(isGeminiModel({ provider: "google", id: "some-other-model" })).toBe(true);
	});

	it("returns false when neither provider nor id match", () => {
		expect(isGeminiModel({ provider: "anthropic", id: "claude-opus-4-8" })).toBe(false);
		expect(isGeminiModel({ provider: "openai", id: "gpt-5.5" })).toBe(false);
	});

	it("is case-insensitive for provider", () => {
		expect(isGeminiModel({ provider: "Google", id: "some-model" })).toBe(true);
		expect(isGeminiModel({ provider: "GOOGLE-VERTEX", id: "some-model" })).toBe(true);
	});

	it("is case-insensitive for id", () => {
		expect(isGeminiModel({ provider: "other", id: "GEMINI-3.1-PRO" })).toBe(true);
	});
});

describe("getModePromptSource", () => {
	it("returns 'gpt' for openai gpt model", () => {
		expect(getModePromptSource({ provider: "openai", id: "gpt-5.5" })).toBe("gpt");
	});

	it("returns 'gpt' for proxy providers with gpt in id", () => {
		expect(getModePromptSource({ provider: "openai-codex", id: "gpt-5.5" })).toBe("gpt");
		expect(getModePromptSource({ provider: "litellm", id: "gpt-5.4" })).toBe("gpt");
		expect(getModePromptSource({ provider: "vercel", id: "gpt-5.5" })).toBe("gpt");
	});

	it("returns 'gemini' for google provider", () => {
		expect(getModePromptSource({ provider: "google", id: "gemini-3.1-pro" })).toBe("gemini");
	});

	it("returns 'gemini' for google-vertex provider", () => {
		expect(getModePromptSource({ provider: "google-vertex", id: "gemini-3-flash" })).toBe(
			"gemini",
		);
	});

	it("returns 'default' for anthropic claude", () => {
		expect(getModePromptSource({ provider: "anthropic", id: "claude-opus-4-8" })).toBe(
			"default",
		);
	});

	it("returns 'default' for non-gpt/gemini models", () => {
		expect(getModePromptSource({ provider: "opencode-go", id: "kimi-k2.6" })).toBe("default");
		expect(getModePromptSource({ provider: "llama-swap", id: "qwen2.5-coder:14b" })).toBe(
			"default",
		);
	});

	it("keeps unsupported prompt families on default source", () => {
		expect(getModePromptSource({ provider: "anthropic", id: "claude-sonnet-4-6" })).toBe("default");
		expect(getModePromptSource({ provider: "xai", id: "grok-4" })).toBe("default");
		expect(getModePromptSource({ provider: "moonshot", id: "kimi-k2.6" })).toBe("default");
	});

	it("prioritizes gpt check over gemini check", () => {
		// If a model somehow had both "gpt" and "gemini" in id, gpt wins
		expect(getModePromptSource({ provider: "weird", id: "gpt-gemini-hybrid" })).toBe("gpt");
	});

	it("returns 'gemini' when provider is google even if id does not contain gemini", () => {
		expect(getModePromptSource({ provider: "google", id: "some-other-model" })).toBe("gemini");
	});
});
