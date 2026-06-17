/**
 * Model family detection — literal classification by provider and model id.
 *
 * Detects GPT, Gemini, and default families for dynamic mode selection.
 * Works across proxy providers (litellm, openai-codex, vercel) and direct providers.
 */

/**
 * Strip provider prefix and lowercase. Input: { provider, id }.
 * Examples: "openai/gpt-5.5" → "gpt-5.5"; "litellm/gpt-5.4" → "gpt-5.4"
 */
export function extractModelId(model: { provider: string; id: string }): string {
	return model.id.toLowerCase();
}

/**
 * True when extracted model id contains "gpt" (case-insensitive).
 * Covers proxy providers like litellm, openai-codex, vercel.
 */
export function isGptModel(model: { provider: string; id: string }): boolean {
	return extractModelId(model).includes("gpt");
}

/**
 * True when provider starts with "google" or "google-vertex", OR extracted id contains "gemini".
 */
export function isGeminiModel(model: { provider: string; id: string }): boolean {
	const providerLower = model.provider.toLowerCase();
	const idLower = extractModelId(model);

	return providerLower.startsWith("google") || idLower.includes("gemini");
}

/**
 * Returns "gpt" | "gemini" | "default". Checks isGptModel first, then isGeminiModel, else "default".
 */
export function getModePromptSource(
	model: { provider: string; id: string },
): "gpt" | "gemini" | "default" {
	if (isGptModel(model)) {
		return "gpt";
	}
	if (isGeminiModel(model)) {
		return "gemini";
	}
	return "default";
}
