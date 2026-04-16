import type { SessionLocalContext } from "../../../session-local/storage.js";
import {
	getSessionLocalPath,
	readSessionLocalFile,
	writeSessionLocalFile,
} from "../../../session-local/storage.js";

export const PLAN_FILE_NAME = "PLAN.md";
export const LOCAL_PLAN_URI = `local://${PLAN_FILE_NAME}`;

export function getLocalPlanPath(ctx: SessionLocalContext): string {
	return getSessionLocalPath(ctx, PLAN_FILE_NAME);
}

export async function readLocalPlanFile(ctx: SessionLocalContext): Promise<string> {
	return readSessionLocalFile(ctx, PLAN_FILE_NAME);
}

export async function writeLocalPlanFile(ctx: SessionLocalContext, content: string): Promise<string> {
	return writeSessionLocalFile(ctx, PLAN_FILE_NAME, content);
}
