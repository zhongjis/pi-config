import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { withStatus } from "./status.js";

// ---------------------------------------------------------------------------
// confirmOrAbort
// ---------------------------------------------------------------------------

/**
 * Wraps `ctx.ui.confirm(title, question)`.
 * Returns `true` if the user confirmed, `false` if cancelled or no UI.
 * Never throws.
 */
export async function confirmOrAbort(
  ctx: ExtensionContext,
  title: string,
  question: string,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  try {
    const result = await ctx.ui.confirm(title, question);
    return result === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// selectOrAbort
// ---------------------------------------------------------------------------

/**
 * Wraps `ctx.ui.select(title, items)`.
 * Returns the selected string, or `null` if cancelled or no UI.
 */
export async function selectOrAbort(
  ctx: ExtensionContext,
  title: string,
  items: string[],
): Promise<string | null> {
  if (!ctx.hasUI) return null;
  try {
    const result = await ctx.ui.select(title, items);
    return result ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// withSpinner
// ---------------------------------------------------------------------------

/**
 * Displays a status indicator while `fn` is running, then clears it.
 * Delegates to `withStatus` from `status.ts`.
 */
export async function withSpinner<T>(
  ctx: ExtensionContext,
  statusKey: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withStatus(ctx, statusKey, label, fn);
}
