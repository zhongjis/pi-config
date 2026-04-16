import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionLocalContext } from "../../session-local/storage.js";
import { PLAN_FILE_NAME, readLocalPlanFile, writeLocalPlanFile } from "./plan-local.js";
import type { ModeStateManager } from "./mode-state.js";
import type { PlanEntry, PlanTitleSource } from "./types.js";

interface PlanStorageContext extends SessionLocalContext {
	cwd?: string;
	sessionManager: SessionLocalContext["sessionManager"] & {
		getEntries(): Array<{ type: string; customType?: string; data?: PlanEntry }>;
	};
}

type PlanSnapshotSource = "local" | "cwd-legacy-local-path" | "legacy-entry";

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

function shouldPreserveExplicitTitle(state: PlanStateLike): boolean {
	return (
		state.planTitleSource === "explicit-exit" &&
		(state.currentMode !== "fuxi" || state.planReviewPending)
	);
}

function getLatestPlanEntry(ctx: PlanStorageContext): PlanEntry | undefined {
	const entries = ctx.sessionManager.getEntries();
	const planEntry = entries
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "plan")
		.pop() as { data?: PlanEntry } | undefined;

	return planEntry?.data?.content ? planEntry.data : undefined;
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

function buildContentBackedSnapshot(
	content: string,
	source: Exclude<PlanSnapshotSource, "legacy-entry">,
	state: PlanStateLike,
): HydratedPlanSnapshot {
	const headingTitle = derivePlanTitleFromMarkdown(content);
	const preserveExplicitTitle = shouldPreserveExplicitTitle(state);
	const title = preserveExplicitTitle ? state.planTitle : (headingTitle ?? state.planTitle);
	const titleSource = preserveExplicitTitle
		? state.planTitleSource
		: (headingTitle ? "content-h1" : state.planTitle ? (state.planTitleSource ?? "cached-state") : undefined);

	return {
		content,
		title,
		titleSource,
		source,
	};
}

async function readLegacyLiteralLocalPlanFile(ctx: PlanStorageContext): Promise<string | undefined> {
	const cwd = typeof ctx.cwd === "string" ? ctx.cwd.trim() : "";
	if (!cwd) return undefined;

	try {
		return await readFile(resolve(cwd, "local:", PLAN_FILE_NAME), "utf8");
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

export async function readHydratedPlanSnapshot(
	ctx: PlanStorageContext,
	state: PlanStateLike,
): Promise<HydratedPlanSnapshot | undefined> {
	try {
		const content = await readLocalPlanFile(ctx);
		return buildContentBackedSnapshot(content, "local", state);
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") {
			throw error;
		}
	}

	const literalLocalContent = await readLegacyLiteralLocalPlanFile(ctx);
	if (literalLocalContent !== undefined) {
		return buildContentBackedSnapshot(literalLocalContent, "cwd-legacy-local-path", state);
	}

	const legacyPlan = getLatestPlanEntry(ctx);
	if (legacyPlan?.content) {
		return {
			content: legacyPlan.content,
			title: legacyPlan.title,
			titleSource: legacyPlan.title ? "legacy-entry" : undefined,
			source: "legacy-entry",
		};
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
