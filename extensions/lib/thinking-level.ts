/**
 * Thinking-level parsing and validation.
 *
 * Shared by extensions that interpret model spec strings from agent
 * frontmatter (e.g. `model: anthropic/claude-opus-4-7:high`).
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (value == null) return undefined;
	if (value === "none") return "off";
	return VALID_THINKING_LEVELS.has(value as ThinkingLevel)
		? (value as ThinkingLevel)
		: undefined;
}

export function isValidThinkingLevel(s: string): s is ThinkingLevel {
	return VALID_THINKING_LEVELS.has(s as ThinkingLevel);
}
