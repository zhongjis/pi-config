import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mode } from "./types.js";

const BOOTSTRAP_MARKER_PREFIX = "mode-skill-bootstrap:";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const modesRoot = resolve(sourceDir, "..", "..", "..", "modes");
const MODES_WITH_SKILLS: ReadonlySet<Mode> = new Set(["fuxi", "luban"]);

type ModeSkillBootstrap = {
	skillName: string;
};

const MODE_SKILL_BOOTSTRAPS: Partial<Record<Mode, ModeSkillBootstrap>> = {
	fuxi: { skillName: "ulw-plan" },
};

type ModeStateEntry = {
	type?: string;
	customType?: string;
	data?: { mode?: unknown };
};

export function getModeSkillPaths(mode: Mode): string[] {
	if (!MODES_WITH_SKILLS.has(mode)) return [];
	return [getModeSkillsDir(mode)];
}

export function getActiveModeFromContext(ctx: ExtensionContext, currentMode: Mode): Mode {
	if (currentMode !== "kuafu") return currentMode;
	return latestPersistedMode(ctx) ?? currentMode;
}

export function getModeSkillBootstrapContent(mode: Mode): string | null {
	const bootstrap = MODE_SKILL_BOOTSTRAPS[mode];
	if (!bootstrap) return null;

	try {
		const skillContent = readFileSync(resolve(getModeSkillsDir(mode), bootstrap.skillName, "SKILL.md"), "utf8");
		const body = stripFrontmatter(skillContent);
		return `${bootstrapMarker(mode)}\n\n${body}`;
	} catch {
		return null;
	}
}

export function messageContainsModeSkillBootstrap(message: unknown, mode: Mode): boolean {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.includes(bootstrapMarker(mode));
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		return (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string" &&
			(part as { text: string }).text.includes(bootstrapMarker(mode))
		);
	});
}

export function firstNonCompactionSummaryIndex(messages: unknown[]): number {
	let index = 0;
	while ((messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary") {
		index += 1;
	}
	return index;
}

function getModeSkillsDir(mode: Mode): string {
	return resolve(modesRoot, mode, "skills");
}

function latestPersistedMode(ctx: ExtensionContext): Mode | undefined {
	const getEntries = ctx.sessionManager?.getEntries;
	if (typeof getEntries !== "function") return undefined;

	const entries = getEntries.call(ctx.sessionManager) as ModeStateEntry[];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== "agent-mode") continue;
		return parseMode(entry.data?.mode);
	}
	return undefined;
}

function parseMode(value: unknown): Mode | undefined {
	if (value === "kuafu" || value === "fuxi" || value === "houtu" || value === "luban" || value === "shennong") {
		return value;
	}
	return undefined;
}

function stripFrontmatter(content: string): string {
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
	return (match ? match[1] : content).trim();
}

function bootstrapMarker(mode: Mode): string {
	return `${BOOTSTRAP_MARKER_PREFIX}${mode}`;
}
