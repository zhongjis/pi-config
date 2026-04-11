import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readPlanFile, writePlanFile } from "../../local-plan-tools/storage.js";
import type { ModeStateManager } from "./mode-state.js";
import type { PlanEntry, PlanTitleSource } from "./types.js";

export const LOCAL_PLAN_URI = "local://PLAN.md";

type PlanSnapshotSource = "local" | "legacy-entry";

export interface HydratedPlanSnapshot {
	content: string;
	title?: string;
	titleSource?: PlanTitleSource;
	source: PlanSnapshotSource;
}

type PlanStateLike = Pick<
	ModeStateManager,
	| "currentMode"
	| "planActionPending"
	| "planContent"
	| "planTitle"
	| "planTitleSource"
	| "planReviewPending"
	| "highAccuracyReviewPending"
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
		(state.currentMode !== "fuxi" || state.planActionPending || state.planReviewPending || state.highAccuracyReviewPending)
	);
}

function getLatestPlanEntry(ctx: ExtensionContext): PlanEntry | undefined {
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

export async function readHydratedPlanSnapshot(
	ctx: ExtensionContext,
	state: PlanStateLike,
): Promise<HydratedPlanSnapshot | undefined> {
	try {
		const content = await readPlanFile(ctx);
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
			source: "local",
		};
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") {
			throw error;
		}
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
	ctx: ExtensionContext,
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

export async function writeLocalPlanSnapshot(ctx: ExtensionContext, content: string): Promise<HydratedPlanSnapshot> {
	await writePlanFile(ctx, content);
	const title = derivePlanTitleFromMarkdown(content);
	return {
		content,
		title,
		titleSource: title ? "content-h1" : undefined,
		source: "local",
	};
}

export function resolveExitPlanTitle(
	snapshot: HydratedPlanSnapshot,
	explicitTitle?: string,
): { title?: string; titleSource?: PlanTitleSource } {
	if (explicitTitle) {
		return { title: explicitTitle, titleSource: "explicit-exit" };
	}

	const headingTitle = snapshot.source === "local" ? derivePlanTitleFromMarkdown(snapshot.content) : undefined;
	if (headingTitle) {
		return { title: headingTitle, titleSource: "content-h1" };
	}

	if (snapshot.source !== "local" && snapshot.title) {
		return { title: snapshot.title, titleSource: snapshot.titleSource ?? "legacy-entry" };
	}

	return {};
}
