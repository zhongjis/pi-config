import type { SessionLocalContext } from "../../session-local/storage.js";
import {
	getSessionLocalPath,
	readSessionLocalFile,
	writeSessionLocalFile,
} from "../../session-local/storage.js";
import type { ModeStateManager } from "./mode-state.js";
import type { PlanTitleSource } from "./types.js";
import { PLAN_FILE_NAME, DRAFT_FILE_NAME } from "./constants.js";

// ─── Plan-local wrappers ────────────────────────────────────────────────────

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

// ─── Plan hydration ─────────────────────────────────────────────────────────

interface PlanStorageContext extends SessionLocalContext {
	cwd?: string;
	sessionManager: SessionLocalContext["sessionManager"] & {
		getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
	};
}

type PlanSnapshotSource = "local";

export interface HydratedPlanSnapshot {
	content: string;
	title?: string;
	titleSource?: PlanTitleSource;
	source: PlanSnapshotSource;
}

type PlanStateLike = Pick<
	ModeStateManager,
	| "currentMode"
	| "planContent"
	| "planTitle"
	| "planTitleSource"
	| "planReviewPending"
>;

function getErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") {
		return undefined;
	}

	const maybeCode = (error as { code?: unknown }).code;
	return typeof maybeCode === "string" ? maybeCode : undefined;
}

export function derivePlanTitleFromMarkdown(content: string): string | undefined {
	const match = content.match(/^\s{0,3}#\s+(.+?)\s*$/mu);
	if (!match) {
		return undefined;
	}

	const title = match[1].replace(/\s+#+\s*$/u, "").trim();
	return title || undefined;
}

export function formatPlanDisplay(plan: { content: string; title?: string }): string {
	return plan.title ? `# Plan: ${plan.title}\n\n${plan.content}` : plan.content;
}

export async function readHydratedPlanSnapshot(
	ctx: PlanStorageContext,
	state: PlanStateLike,
): Promise<HydratedPlanSnapshot | undefined> {
	try {
		const content = await readLocalPlanFile(ctx);
		const headingTitle = derivePlanTitleFromMarkdown(content);
		const title = headingTitle ?? state.planTitle;
		const titleSource: PlanTitleSource | undefined = headingTitle
			? "content-h1"
			: state.planTitle
				? (state.planTitleSource ?? "cached-state")
				: undefined;

		return {
			content,
			title,
			titleSource,
			source: "local",
		};
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") {
			throw error;
		}
	}

	return undefined;
}

export async function hydratePlanState(
	ctx: PlanStorageContext,
	state: ModeStateManager,
): Promise<HydratedPlanSnapshot | undefined> {
	const snapshot = await readHydratedPlanSnapshot(ctx, state);
	if (!snapshot) {
		state.planContent = undefined;
		state.planTitle = undefined;
		state.planTitleSource = undefined;
		return undefined;
	}

	state.planContent = snapshot.content;
	state.planTitle = snapshot.title;
	state.planTitleSource = snapshot.titleSource;
	return snapshot;
}

export async function writeLocalPlanSnapshot(ctx: PlanStorageContext, content: string): Promise<HydratedPlanSnapshot> {
	await writeLocalPlanFile(ctx, content);
	const title = derivePlanTitleFromMarkdown(content);
	return {
		content,
		title,
		titleSource: title ? "content-h1" : undefined,
		source: "local",
	};
}
