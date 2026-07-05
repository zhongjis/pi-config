/**
 * Advisory appended to subagent tool results when the caller's prompt/message
 * references `local://` paths.
 *
 * Session-local storage is per-session, so a parent session's `local://` files
 * are not visible to the delegated subagent's own session. This is a
 * non-blocking heads-up for the caller — `local://` in a prompt is legitimate
 * when the subagent is meant to create its own file.
 */
export const LOCAL_URI_SUBAGENT_HINT =
  "\n\n⚠ `local://` is session-scoped; the subagent can't read the current session's `local://` files. Inline the content or use a real path (ignore if it should write its own).";

/** Returns the hint suffix when any source text references a `local://` path, else "". */
export function localUriHint(...sources: (string | undefined)[]): string {
  return sources.some(source => source?.includes("local://")) ? LOCAL_URI_SUBAGENT_HINT : "";
}
