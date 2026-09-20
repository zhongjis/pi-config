// Derived from L2ncE/pi-recap at commit 02057d0; modified by Panda Harness. See README.md and LICENSE.

import { resolveModel } from "../lib/model-selection.js";
import type { ModelCandidate, ModelRegistry } from "../lib/model-selection.js";
import { getToolModelSelection, loadToolModelsConfig } from "../lib/tool-models.js";

export const RECAP_TOOL_KEY = "recap.generate";

export type RecapModel = ReturnType<ModelRegistry["find"]>;

export type RecapCandidate = {
	model: RecapModel;
	thinkingLevel?: ModelCandidate["thinkingLevel"];
};

type RecapModelRegistry = ModelRegistry & {
	hasConfiguredAuth?(model: RecapModel): boolean;
};

type RecapModelContext = {
	cwd: string;
	model?: unknown;
	modelRegistry: RecapModelRegistry;
};

export type RecapCompletion = {
	stopReason?: unknown;
	content?: unknown;
};

export type RecapCompletionResult =
	| { kind: "completed"; response: RecapCompletion }
	| { kind: "skipped"; reason: "aborted" | "output truncated" | "generation failed" };

export function resolveRecapModelCandidates(ctx: RecapModelContext): RecapCandidate[] {
	const selection = getToolModelSelection(loadToolModelsConfig(ctx.cwd), RECAP_TOOL_KEY);
	const resolved: RecapCandidate[] = [];
	for (const candidate of selection?.candidates ?? []) {
		const model = resolveModel(candidate.model, ctx.modelRegistry);
		if (typeof model === "string" || !isRecapModel(model) || includesModel(resolved, model)) continue;
		resolved.push({ model, thinkingLevel: candidate.thinkingLevel });
	}

	if (isRecapModel(ctx.model) && ctx.modelRegistry.hasConfiguredAuth?.(ctx.model) && !includesModel(resolved, ctx.model)) {
		resolved.push({ model: ctx.model });
	}
	return resolved;
}

export async function completeRecap<Request>(
	complete: (candidate: RecapCandidate, request: Request) => Promise<RecapCompletion>,
	candidates: RecapCandidate[],
	request: Request,
	signal?: AbortSignal,
	warn: (message: string) => void = console.warn,
): Promise<RecapCompletionResult> {
	const failures: string[] = [];
	for (const candidate of candidates) {
		if (signal?.aborted) return { kind: "skipped", reason: "aborted" };
		try {
			const response = await complete(candidate, request);
			if (signal?.aborted) return { kind: "skipped", reason: "aborted" };
			if (response.stopReason === "length") return { kind: "skipped", reason: "output truncated" };
			if (response.stopReason === "error") {
				failures.push(`${modelIdentity(candidate.model)}: provider stopReason=error`);
				continue;
			}
			return { kind: "completed", response };
		} catch (error) {
			if (error instanceof Error) {
				if (signal?.aborted || isAbortError(error)) return { kind: "skipped", reason: "aborted" };
				failures.push(`${modelIdentity(candidate.model)}: ${error.name}`);
			} else {
				failures.push(`${modelIdentity(candidate.model)}: unknown error`);
			}
		}
	}
	if (failures.length > 0) warn(`[pi-recap] recap generation failed: ${failures.join("; ")}`);
	return { kind: "skipped", reason: "generation failed" };
}

function includesModel(candidates: RecapCandidate[], model: RecapModel): boolean {
	return candidates.some((candidate) => candidate.model.provider === model.provider && candidate.model.id === model.id);
}

function modelIdentity(model: RecapModel): string {
	return `${model.provider}/${model.id}`;
}

function isRecapModel(value: unknown): value is RecapModel {
	return (
		typeof value === "object" &&
		value !== null &&
		"provider" in value &&
		typeof value.provider === "string" &&
		"id" in value &&
		typeof value.id === "string"
	);
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error) return error.name === "AbortError" || /\babort(?:ed|ing)?\b/i.test(error.message);
	return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

