/** Latest persisted `agent-mode` session entry selection. Callers own validation and fallback policy. */
export interface ModeStateEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/**
 * Newest `agent-mode` custom entry in session `entries` (pass `getEntries()`, never `getBranch()`); data is returned unvalidated.
 * The scan runs newest first and stops at the first match. Entries newer than the match must be objects; a nullish one throws.
 * `accept` filters raw entries before the match, so the result equals selecting from `entries.filter(accept)`.
 */
export function findLatestModeStateEntry<T extends ModeStateEntryLike>(
	entries: readonly T[],
	accept?: (entry: T) => unknown,
): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (accept && !accept(entry)) continue;
		if (entry.type === "custom" && entry.customType === "agent-mode") return entry;
	}
	return undefined;
}
