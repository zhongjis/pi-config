/** Latest persisted `agent-mode` session entry selection. Callers own validation and fallback policy. */
export interface ModeStateEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/** Newest `agent-mode` custom entry in session `entries` (pass `getEntries()`, never `getBranch()`); data is returned unvalidated. */
export function findLatestModeStateEntry(entries: readonly ModeStateEntryLike[]): ModeStateEntryLike | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "custom" && entry.customType === "agent-mode") return entry;
	}
	return undefined;
}
