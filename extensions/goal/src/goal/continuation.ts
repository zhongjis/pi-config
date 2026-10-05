import type { CustomMessageEntryDraft, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalStoreRef } from "./context.js";
import { buildBudgetLimitedPrompt, buildContinuationPrompt } from "./prompt.js";
import { readGoal } from "./store.js";
import type { Goal } from "./types.js";

/** Process-local admission; native boundaries own in-run continuation. */
export function createGoalAdmission() {
	let generation = 0;
	let reserved = false;
	let budgetReportedId: string | null = null;
	return {
		get generation() {
			return generation;
		},
		invalidate() {
			generation++;
			reserved = false;
		},
		started() {
			reserved = false;
		},
		committed(goal: Goal) {
			if (goal.status === "budgetLimited") budgetReportedId = goal.id;
		},
		async admit(ctx: ExtensionContext, goal: Goal, boundary = false): Promise<CustomMessageEntryDraft | undefined> {
			if (reserved || (goal.status !== "active" && !(boundary && goal.status === "budgetLimited"))) return;
			const ref = goalStoreRef(ctx);
			const capturedGeneration = generation;
			reserved = true;
			let admitted = false;
			try {
				const current = await readGoal(ref);
				if (capturedGeneration !== generation || current?.id !== goal.id || current.status !== goal.status) return;
				if (ctx.signal?.aborted || ctx.hasPendingMessages() || (!boundary && !ctx.isIdle())) return;
				if (current.status === "budgetLimited" && budgetReportedId === current.id) return;
				admitted = true;
				return {
					type: "custom_message",
					customType: current.status === "active" ? "pi-goal-continuation" : "pi-goal-budget-limit",
					content: current.status === "active" ? buildContinuationPrompt(current) : buildBudgetLimitedPrompt(current),
					display: false,
					details: { goalId: current.id },
				};
			} finally {
				// The caller commits synchronously after this promise resolves. Other
				// candidates stay excluded until the next run or an explicit control.
				if (!admitted && capturedGeneration === generation) reserved = false;
			}
		},
	};
}
