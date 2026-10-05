import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGoalForContext } from "./context.js";
import { isRecord } from "./types.js";

export const GOAL_TOOL_NAMES = ["create_goal", "get_goal", "update_goal"] as const;
export const GOAL_ACCESS_ENTRY = "pi-goal-access";
export const GOAL_TOOL_OWNER_CHANNEL = "modes:rpc:goal-tool-owner";

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

/** Synchronous discovery: no listener means standalone Goal owns its declarations. */
export function modesOwnGoalTools(pi: ExtensionAPI): boolean {
	const requestId = randomUUID();
	let owned = false;
	const unsubscribe = pi.events.on(`${GOAL_TOOL_OWNER_CHANNEL}:reply:${requestId}`, (reply: unknown) => {
		if (typeof reply === "object" && reply !== null && "success" in reply && reply.success === true &&
			"data" in reply && reply.data === true) owned = true;
	});
	try {
		pi.events.emit(GOAL_TOOL_OWNER_CHANNEL, { requestId });
	} finally {
		unsubscribe();
	}
	return owned;
}
