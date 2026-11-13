/** Latest persisted `agent-mode` session entry selection. Callers own validation and fallback policy. */
export interface ModeStateEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/** True for a persisted `agent-mode` custom entry. Reads `type`, so a nullish entry throws. */
export function isModeStateEntry(entry: ModeStateEntryLike): boolean {
	return entry.type === "custom" && entry.customType === "agent-mode";
}

/**
 * Newest `agent-mode` custom entry in session `entries` (pass `getEntries()`, never `getBranch()`); data is returned unvalidated.
 * Visits indices newest first and stops at the first match. Calls `accept` on each visited value before matching; rejected values are skipped.
 * A nullish value that `accept` does not reject throws when inspected.
 */
export function findLatestModeStateEntry<T extends ModeStateEntryLike>(
	entries: readonly T[],
	accept?: (entry: T) => unknown,
): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (accept && !accept(entry)) continue;
		if (isModeStateEntry(entry)) return entry;
	}
	return undefined;
}
