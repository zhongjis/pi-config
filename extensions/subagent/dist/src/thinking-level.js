const VALID_THINKING_LEVELS = new Set([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
]);
export function normalizeThinkingLevel(value) {
    if (value == null)
        return undefined;
    if (value === "off")
        return "none";
    return VALID_THINKING_LEVELS.has(value)
        ? value
        : undefined;
}
