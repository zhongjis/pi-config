import { MODE_COLORS, RESET, SAFE_BASH_PREFIXES } from "./constants.js";
import type { Mode, ModeConfig } from "./types.js";

export function colored(mode: Mode, text: string): string {
	return `${MODE_COLORS[mode]}${text}${RESET}`;
}

export function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	return SAFE_BASH_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function dedupeCaseInsensitive(values: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const value of values) {
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(value);
	}
	return deduped;
}

export function getPermittedDelegationTargets(
	config: Pick<ModeConfig, "allowDelegationTo" | "disallowDelegationTo">,
): string[] | undefined {
	if (!config.allowDelegationTo?.length) return undefined;

	const allowlisted = dedupeCaseInsensitive(config.allowDelegationTo);
	if (!config.disallowDelegationTo?.length) {
		return allowlisted;
	}

	const disallowed = new Set(
		config.disallowDelegationTo.map((value) => value.toLowerCase()),
	);
	return allowlisted.filter((value) => !disallowed.has(value.toLowerCase()));
}

export function isDelegationAllowed(
	config: Pick<ModeConfig, "allowDelegationTo" | "disallowDelegationTo">,
	target: string,
): {
	allowed: boolean;
	permittedTargets?: string[];
} {
	const normalizedTarget = target.trim().toLowerCase();

	const permittedTargets = getPermittedDelegationTargets(config);
	if (permittedTargets) {
		return {
			allowed: permittedTargets.some(
				(value) => value.toLowerCase() === normalizedTarget,
			),
			permittedTargets,
		};
	}

	if (config.disallowDelegationTo?.length) {
		return {
			allowed: !config.disallowDelegationTo.some(
				(value) => value.toLowerCase() === normalizedTarget,
			),
		};
	}

	return { allowed: true };
}

export function parseCsv(val: unknown): string[] | undefined {
	if (val === undefined || val === null) return undefined;
	const s = String(val).trim();
	if (!s || s.toLowerCase() === "none") return undefined;
	return s
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
}

export function parseInheritField(val: unknown): true | string[] | undefined {
	if (val === undefined || val === null || val === true) return undefined;
	if (val === false || val === "none") return undefined;
	const items = parseCsv(val);
	return items && items.length > 0 ? items : undefined;
}

/**
 * Resolve a fuzzy model string (e.g. "claude-opus-4.6" or "anthropic/claude-opus-4") to a Model.
 * Returns the resolved model or undefined on failure.
 */
export function resolveModelFromStr(
	input: string,
	registry: { find(provider: string, modelId: string): any; getAvailable?(): any[]; getAll(): any[] },
): any | undefined {
	const all = (registry.getAvailable?.() ?? registry.getAll()) as Array<{ id: string; name: string; provider: string }>;
	const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

	// 1. Exact "provider/modelId" match
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
	let bestMatch: (typeof all)[number] | undefined;
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
		} else if (query.split(/[\s\-/]+/).every(part => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))) {
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

	return undefined;
}
