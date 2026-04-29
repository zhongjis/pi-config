const VALID_THINKING_LEVELS = new Set([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
]);
export function normalizeThinkingLevel(value) {
    if (value == null)
        return undefined;
    if (value === "none")
        return "off";
    return VALID_THINKING_LEVELS.has(value)
        ? value
        : undefined;
}
