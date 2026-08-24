/**
 * Thinking-level normalization for subagent frontmatter and invocation params.
 *
 * Only the legacy "none" alias is rewritten to "off" for backward compat with
 * existing agent frontmatter. Every other value is passed through unchanged —
 * pi validates the level at session creation, and newer levels (e.g. "max")
 * must not be dropped.
 */
import type { ThinkingLevel } from "./types.js";

export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value == null) return undefined;
  return (value === "none" ? "off" : value) as ThinkingLevel;
}
