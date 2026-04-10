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
