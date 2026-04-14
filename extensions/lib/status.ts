import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// StatusPart
// ---------------------------------------------------------------------------

export type StatusPart = {
  text: string;
  color?: string;
  bold?: boolean;
};

// ---------------------------------------------------------------------------
// withStatus
// ---------------------------------------------------------------------------

/**
 * Sets `ctx.ui.setStatus(key, text)` before calling `fn`, then clears it in
 * a `finally` block. Guards with `ctx.hasUI` — if no UI, `fn` still runs.
 */
export async function withStatus<T>(
  ctx: ExtensionContext,
  key: string,
  text: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (ctx.hasUI) {
    ctx.ui.setStatus(key, text);
  }
  try {
    return await fn();
  } finally {
    if (ctx.hasUI) {
      ctx.ui.setStatus(key, undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// buildStatusLine
// ---------------------------------------------------------------------------

const DEFAULT_SEPARATOR = " · ";

/**
 * Composes a single status line string from an array of `StatusPart` segments.
 * Parts are joined with `separator` (default `" · "`).
 * If `maxWidth` is provided, the result is truncated via `truncateToWidth`.
 * Theme methods `fg` and `bold` are used for styling if supplied.
 */
export function buildStatusLine(
  theme: ExtensionContext["ui"]["theme"],
  parts: StatusPart[],
  maxWidth?: number,
  separator = DEFAULT_SEPARATOR,
): string {
  const segments = parts.map((part) => {
    let text = part.text;
    if (part.color) text = theme.fg(part.color, text);
    if (part.bold) text = theme.bold(text);
    return text;
  });

  const line = segments.join(separator);

  if (maxWidth !== undefined) {
    return truncateToWidth(line, maxWidth);
  }

  return line;
}
