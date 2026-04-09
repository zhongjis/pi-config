import { MODE_COLORS, RESET, SAFE_BASH_PREFIXES } from "./constants.js";
import type { Mode } from "./types.js";

export function colored(mode: Mode, text: string): string {
	return `${MODE_COLORS[mode]}${text}${RESET}`;
}

export function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	return SAFE_BASH_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function parseCsv(val: unknown): string[] | undefined {
	if (val === undefined || val === null) return undefined;
	const s = String(val).trim();
	if (!s || s.toLowerCase() === "none") return undefined;
	return s.split(",").map((v) => v.trim()).filter(Boolean);
}

export function parseInheritField(val: unknown): true | string[] | undefined {
	if (val === undefined || val === null || val === true) return undefined;
	if (val === false || val === "none") return undefined;
	const items = parseCsv(val);
	return items && items.length > 0 ? items : undefined;
}
