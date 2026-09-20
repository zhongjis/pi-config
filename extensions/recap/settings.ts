// Derived from L2ncE/pi-recap at commit 02057d0; modified by Panda Harness. See README.md and LICENSE.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { positiveInt, unitRatio } from "./content.js";

const DEFAULT_MAX_WORDS = 40;
const MIN_TURNS = 3;
const AUTO_UPDATE_COOLDOWN_TURNS = 3;
const SIMILARITY_THRESHOLD = 0.7;

export type RecapConfig = {
	maxWords: number;
	minTurns: number;
	cooldownTurns: number;
	similarityThreshold: number;
	prompt: string;
	placement: "aboveEditor" | "belowEditor";
};

type Settings = {
	recap?: {
		maxWords?: unknown;
		minTurns?: unknown;
		cooldownTurns?: unknown;
		similarityThreshold?: unknown;
		placement?: unknown;
		prompts?: { recap?: unknown };
	};
};

export function getRecapConfig(cwd: string): RecapConfig {
	const globalSettings = readJsonFile(join(getAgentDir(), "settings.json"));
	const projectSettings = readJsonFile(join(cwd, ".pi", "settings.json"));
	const recap = readRecapSettings(mergeSettings(globalSettings, projectSettings));
	const maxWords = positiveInt(recap?.maxWords, DEFAULT_MAX_WORDS);
	const prompt = typeof recap?.prompts?.recap === "string" && recap.prompts.recap.trim()
		? recap.prompts.recap.trim()
		: defaultPrompt(maxWords);
	return {
		maxWords,
		minTurns: positiveInt(recap?.minTurns, MIN_TURNS),
		cooldownTurns: positiveInt(recap?.cooldownTurns, AUTO_UPDATE_COOLDOWN_TURNS),
		similarityThreshold: unitRatio(recap?.similarityThreshold, SIMILARITY_THRESHOLD),
		prompt,
		placement: recap?.placement === "above" ? "aboveEditor" : "belowEditor",
	};
}

function defaultPrompt(maxWords: number): string {
	return `The user stepped away and is coming back. Recap in under ${maxWords} words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.`;
}

function readJsonFile(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-recap] settings failed: ${path}: ${message}`);
		return {};
	}
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = result[key];
		result[key] = isRecord(current) && isRecord(value) ? mergeSettings(current, value) : value;
	}
	return result;
}

function readRecapSettings(value: Record<string, unknown>): Settings["recap"] {
	const recap = value.recap;
	if (!isRecord(recap)) return undefined;
	const prompts = isRecord(recap.prompts) ? { recap: recap.prompts.recap } : undefined;
	return {
		maxWords: recap.maxWords,
		minTurns: recap.minTurns,
		cooldownTurns: recap.cooldownTurns,
		similarityThreshold: recap.similarityThreshold,
		placement: recap.placement,
		prompts,
	};
}


function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
