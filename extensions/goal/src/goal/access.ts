import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGoalForContext } from "./context.js";
import { isRecord } from "./types.js";

export const GOAL_TOOL_NAMES = ["create_goal", "get_goal", "update_goal"] as const;
export const GOAL_ACCESS_ENTRY = "pi-goal-access";

/** Activation is session-local; inherited entries never activate another session. */
export async function goalToolAccess(ctx: ExtensionContext): Promise<readonly string[]> {
	const sessionId = ctx.sessionManager.getSessionId();
	const activated = (ctx.sessionManager.getEntries?.() ?? []).some((entry) =>
		entry.type === "custom" && entry.customType === GOAL_ACCESS_ENTRY &&
		isRecord(entry.data) && entry.data.sessionId === sessionId,
	);
	if (activated) return GOAL_TOOL_NAMES;
	const goal = await readGoalForContext(ctx);
	return goal && goal.status !== "complete" ? ["get_goal", "update_goal"] : [];
}
