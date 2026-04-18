import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// debounce
// ---------------------------------------------------------------------------

type DebouncedFn = { (): void; cancel(): void };

/**
 * Returns a debounced version of `fn` that delays invocation by `ms`.
 * The returned function has a `.cancel()` method to clear any pending timer.
 */
export function debounce(fn: () => void, ms: number): DebouncedFn {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = (() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  }) as DebouncedFn;

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}

// ---------------------------------------------------------------------------
// checkExec
// ---------------------------------------------------------------------------

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

interface CheckResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Converts a `pi.exec()` result into a simple `{ ok, stdout, stderr }`.
 * `ok` is true only when `code === 0` and the process was not killed.
 */
export function checkExec(result: ExecResult): CheckResult {
  return {
    ok: result.code === 0 && !result.killed,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// ---------------------------------------------------------------------------
// notifyError
// ---------------------------------------------------------------------------

/**
 * Extracts a message from `err` (supports Error instances or any value) and
 * calls `ctx.ui.notify(...)` with level `"error"`.
 * Falls back to `console.error` when the UI is not available.
 */
export function notifyError(
  ctx: ExtensionContext,
  err: unknown,
  label: string,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const text = label ? `${label}: ${message}` : message;
  if (ctx.hasUI) {
    ctx.ui.notify(text, "error");
  } else {
    console.error(text);
  }
}

// ---------------------------------------------------------------------------
// requireUI
// ---------------------------------------------------------------------------

/**
 * Returns `ctx.hasUI`. A readable guard for UI-only code paths.
 */
export function requireUI(ctx: ExtensionContext): boolean {
  return ctx.hasUI;
}

// ---------------------------------------------------------------------------
// safeModel
// ---------------------------------------------------------------------------

/**
 * Returns `ctx.model` or `null` if unavailable.
 */
export function safeModel(ctx: ExtensionContext): ExtensionContext["model"] | null {
  return ctx.model ?? null;
}

// ---------------------------------------------------------------------------
// safeUsage
// ---------------------------------------------------------------------------

/**
 * Calls `ctx.getContextUsage()` and returns the result, or `null` if it throws.
 */
export function safeUsage(ctx: ExtensionContext): ReturnType<ExtensionContext["getContextUsage"]> | null {
  try {
    return ctx.getContextUsage();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// computeLineDiff
// ---------------------------------------------------------------------------

/**
 * Produces a minimal line diff between two strings.
 * Lines only in `oldContent` get a `-` prefix; lines only in `newContent` get a `+` prefix.
 * Returns an empty string when both inputs are identical.
 */
export function computeLineDiff(oldContent: string, newContent: string): string {
	if (oldContent === newContent) return "";

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const result: string[] = [];

	const maxLen = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < maxLen; i++) {
		const oldLine = i < oldLines.length ? oldLines[i] : undefined;
		const newLine = i < newLines.length ? newLines[i] : undefined;

		if (oldLine === newLine) {
			result.push(` ${oldLine}`);
		} else {
			if (oldLine !== undefined) result.push(`-${oldLine}`);
			if (newLine !== undefined) result.push(`+${newLine}`);
		}
	}

	return result.join("\n");
}
