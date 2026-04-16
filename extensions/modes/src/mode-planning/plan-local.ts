import type { SessionLocalContext } from "../../../session-local/storage.js";
import {
	getSessionLocalPath,
	readSessionLocalFile,
	writeSessionLocalFile,
} from "../../../session-local/storage.js";

export const PLAN_FILE_NAME = "PLAN.md";
export const LOCAL_PLAN_URI = `local://${PLAN_FILE_NAME}`;

export const DRAFT_FILE_NAME = "DRAFT.md";
export const LOCAL_DRAFT_URI = `local://${DRAFT_FILE_NAME}`;

export function getLocalPlanPath(ctx: SessionLocalContext): string {
	return getSessionLocalPath(ctx, PLAN_FILE_NAME);
}

export function getLocalDraftPath(ctx: SessionLocalContext): string {
	return getSessionLocalPath(ctx, DRAFT_FILE_NAME);
}

export async function readLocalPlanFile(ctx: SessionLocalContext): Promise<string> {
	return readSessionLocalFile(ctx, PLAN_FILE_NAME);
}

export async function readLocalDraftFile(ctx: SessionLocalContext): Promise<string> {
	return readSessionLocalFile(ctx, DRAFT_FILE_NAME);
}

export async function writeLocalPlanFile(ctx: SessionLocalContext, content: string): Promise<string> {
	return writeSessionLocalFile(ctx, PLAN_FILE_NAME, content);
}

export async function writeLocalDraftFile(ctx: SessionLocalContext, content: string): Promise<string> {
	return writeSessionLocalFile(ctx, DRAFT_FILE_NAME, content);
}
