/**
 * Reserved module for a `stop_subagent` tool.
 *
 * The current public tool surface has no LLM-facing `stop_subagent` tool —
 * user-initiated aborts flow through `/agents` and turn cancellation, and
 * background agents are stopped via supervision (auto-abort) rather than a
 * dedicated tool. This module is intentionally empty; adding a stop tool here
 * is the documented seam if that contract ever changes.
 */

export {};
