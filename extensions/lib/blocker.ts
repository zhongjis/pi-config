export type BlockerRecord = {
	status: string;
};

export type BlockerStore = {
	get(id: string): BlockerRecord | undefined;
};

export type BlockerGroups = {
	satisfied: string[];
	unsatisfied: string[];
};

export function filterBlockers(blockers: readonly string[], store: BlockerStore): BlockerGroups {
	const satisfied: string[] = [];
	const unsatisfied: string[] = [];

	for (const blockerId of blockers) {
		const blocker = store.get(blockerId);
		if (blocker?.status === "completed") {
			satisfied.push(blockerId);
		} else {
			unsatisfied.push(blockerId);
		}
	}

	return { satisfied, unsatisfied };
}
