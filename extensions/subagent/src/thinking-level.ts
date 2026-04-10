import type { ThinkingLevel } from "./types.js";

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value == null) return undefined;
  if (value === "off") return "none";
  return VALID_THINKING_LEVELS.has(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : undefined;
}
