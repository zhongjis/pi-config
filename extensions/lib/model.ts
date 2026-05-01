/**
 * Model spec string parsing and resolution.
 *
 * Handles the `provider/modelId:thinkingLevel,fallback,...` format used in
 * agent frontmatter `model` fields. Shared by extensions/modes and
 * extensions/subagent.
 */

import type { ThinkingLevel } from "./thinking-level.js";
import { isValidThinkingLevel } from "./thinking-level.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelCandidate {
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ModelEntry {
	id: string;
	name: string;
	provider: string;
}

export interface ModelRegistry {
	find(provider: string, modelId: string): any;
	getAll(): any[];
	getAvailable?(): any[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single model segment: `"provider/modelId:level"` → `{ model, thinkingLevel }`.
 * The `:level` suffix is optional.
 */
export function parseModelPattern(segment: string): ModelCandidate {
	const colonIdx = segment.lastIndexOf(":");
	if (colonIdx === -1) return { model: segment };
	const prefix = segment.slice(0, colonIdx);
	const suffix = segment.slice(colonIdx + 1);
	if (isValidThinkingLevel(suffix)) {
		return { model: prefix, thinkingLevel: suffix };
	}
	return { model: segment };
}

/**
 * Parse a comma-separated model chain: `"a/b:high,c/d:medium"` → `ModelCandidate[]`.
 * First entry is primary; remaining are ordered fallbacks.
 */
export function parseModelChain(input: string): ModelCandidate[] {
	return input
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map(parseModelPattern);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a model string to a Model instance from the registry.
 *
 * Matching strategies (in order):
 * 1. Exact `"provider/modelId"` match (only if available/authed)
 * 2. Fuzzy scored match: exact id > substring > name contains > all-parts-present
 *
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
	input: string,
	registry: ModelRegistry,
): any | string {
	const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
	const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

	// 1. Exact match: "provider/modelId" — only if available (has auth)
	const slashIdx = input.indexOf("/");
	if (slashIdx !== -1) {
		const provider = input.slice(0, slashIdx);
		const modelId = input.slice(slashIdx + 1);
		if (availableSet.has(input.toLowerCase())) {
			const found = registry.find(provider, modelId);
			if (found) return found;
		}
	}

	// 2. Fuzzy match against available models
	const query = input.toLowerCase();

	let bestMatch: ModelEntry | undefined;
	let bestScore = 0;

	for (const m of all) {
		const id = m.id.toLowerCase();
		const name = m.name.toLowerCase();
		const full = `${m.provider}/${m.id}`.toLowerCase();

		let score = 0;
		if (id === query || full === query) {
			score = 100;
		} else if (id.includes(query) || full.includes(query)) {
			score = 60 + (query.length / id.length) * 30;
		} else if (name.includes(query)) {
			score = 40 + (query.length / name.length) * 20;
		} else if (
			query
				.split(/[\s\-/]+/)
				.every(
					(part) =>
						id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part),
				)
		) {
			score = 20;
		}

		if (score > bestScore) {
			bestScore = score;
			bestMatch = m;
		}
	}

	if (bestMatch && bestScore >= 20) {
		const found = registry.find(bestMatch.provider, bestMatch.id);
		if (found) return found;
	}

	// 3. No match
	const modelList = all
		.map((m) => `  ${m.provider}/${m.id}`)
		.sort()
		.join("\n");
	return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

/**
 * Resolve the first available model from a candidate chain against the registry.
 * Returns `{ model, thinkingLevel }` on success, or `undefined` if none matched.
 */
export function resolveFirstAvailable(
	candidates: ModelCandidate[],
	registry: ModelRegistry,
): { model: any; thinkingLevel?: ThinkingLevel } | undefined {
	for (const candidate of candidates) {
		const result = resolveModel(candidate.model, registry);
		if (typeof result !== "string") {
			return { model: result, thinkingLevel: candidate.thinkingLevel };
		}
	}
	return undefined;
}
