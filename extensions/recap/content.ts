// Derived from L2ncE/pi-recap at commit 02057d0; modified by Panda Harness. See README.md and LICENSE.

export type Round = {
	user: string;
	assistant: string;
	tools: string[];
};

export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return "";
			return block.text;
		})
		.filter(Boolean)
		.join(" ");
}

export function extractToolNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") return [];
		return [block.name];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanLine(line: string): string {
	return line
		.replace(/^[-•*]\s+/, "")
		.replace(/^#+\s*/, "")
		.replace(/^\d{1,3}[.)]\s+/, "")
		.replace(/^[※*](?:\s*recap\s*[:：]|\s+)/i, "")
		.replace(/^recap\s*[:：]\s*/i, "")
		.replace(/^(?:here(?:'s| is| are)? (?:a |the )?recap[^:：]*[:：]\s*)/i, "")
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^['"`]+|['"`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.?!。！？]+$/, "");
}

export function cleanSingleLine(text: string, fallback = ""): string {
	for (const part of text.split("\n")) {
		const trimmed = part.trim();
		if (!trimmed || /^#+\s*/.test(trimmed)) continue;
		const cleaned = cleanLine(trimmed);
		if (cleaned) return cleaned;
	}
	return fallback;
}

export function limitWords(text: string, maxWords: number): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return text.trim();
	return `${words.slice(0, maxWords).join(" ")}…`;
}

export function buildInputKey(goal: string, rounds: Round[]): string {
	const last = rounds.at(-1);
	return [goal.slice(0, 80), last?.user.slice(0, 80) ?? "", last?.assistant.slice(0, 80) ?? ""].join("|");
}

function normalizeForCompare(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function similarity(a: string, b: string): number {
	const wordsA = new Set(normalizeForCompare(a).split(" ").filter(Boolean));
	const wordsB = new Set(normalizeForCompare(b).split(" ").filter(Boolean));
	if (wordsA.size === 0 || wordsB.size === 0) return 0;
	const overlap = [...wordsA].filter((word) => wordsB.has(word)).length;
	return overlap / new Set([...wordsA, ...wordsB]).size;
}

export function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export function unitRatio(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

export function isWideChar(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return (
		(code >= 0x1100 && code <= 0x11ff) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		code === 0x203b
	);
}

export function wrapText(text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	let current = "";
	let width = 0;
	for (const ch of text) {
		const charWidth = isWideChar(ch) ? 2 : 1;
		if (width + charWidth > maxWidth && current) {
			lines.push(current);
			current = "";
			width = 0;
		}
		current += ch;
		width += charWidth;
	}
	if (current) lines.push(current);
	return lines;
}
