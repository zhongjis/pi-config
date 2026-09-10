import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type BtwThinkingLevel = (typeof THINKING_LEVELS)[number];
export const TOOL_MODES = ["inherit", "all", "read-only", "none"] as const;
export type BtwToolMode = (typeof TOOL_MODES)[number];
export type BtwSplit = "right" | "down";

export type BtwConfig = {
	autoSubmit: boolean;
	closeOnExit: boolean;
	model: string | null;
	thinking: BtwThinkingLevel | null;
	tools: BtwToolMode;
	split: BtwSplit;
};

export const DEFAULT_CONFIG: Readonly<BtwConfig> = Object.freeze({
	autoSubmit: false,
	closeOnExit: false,
	model: null,
	thinking: null,
	tools: "inherit",
	split: "right",
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isModelName(value: string): boolean {
	return /^[^/\s]+\/\S+$/.test(value);
}

export function parseConfig(value: unknown): BtwConfig {
	if (!isRecord(value)) throw new Error("/btw config must be a JSON object");

	const config = { ...DEFAULT_CONFIG };
	if ("autoSubmit" in value) {
		if (typeof value.autoSubmit !== "boolean") throw new Error("autoSubmit must be true or false");
		config.autoSubmit = value.autoSubmit;
	}
	if ("closeOnExit" in value) {
		if (typeof value.closeOnExit !== "boolean") throw new Error("closeOnExit must be true or false");
		config.closeOnExit = value.closeOnExit;
	}
	if ("model" in value) {
		if (value.model !== null && (typeof value.model !== "string" || !isModelName(value.model))) {
			throw new Error("model must be null or provider/model");
		}
		config.model = value.model as string | null;
	}
	if ("thinking" in value) {
		if (value.thinking !== null && !THINKING_LEVELS.includes(value.thinking as BtwThinkingLevel)) {
			throw new Error(`thinking must be null or one of: ${THINKING_LEVELS.join(", ")}`);
		}
		config.thinking = value.thinking as BtwThinkingLevel | null;
	}
	if ("tools" in value) {
		if (!TOOL_MODES.includes(value.tools as BtwToolMode)) {
			throw new Error("tools must be inherit, all, read-only, or none");
		}
		config.tools = value.tools as BtwToolMode;
	}
	if ("split" in value) {
		if (value.split !== "right" && value.split !== "down") {
			throw new Error("split must be right or down");
		}
		config.split = value.split;
	}
	return config;
}

export function formatConfig(config: BtwConfig): string {
	return [
		`auto-submit: ${config.autoSubmit ? "on" : "off"}`,
		`close-on-exit: ${config.closeOnExit ? "on" : "off"}`,
		`model: ${config.model ?? "inherit"}`,
		`thinking: ${config.thinking ?? "inherit"}`,
		`tools: ${config.tools}`,
		`split: ${config.split}`,
	].join(" · ");
}

export const CONFIG_COMMAND_USAGE =
	"/btw config [auto-submit on|off | close-on-exit on|off | model inherit|provider/model | thinking inherit|off|minimal|low|medium|high|xhigh|max | tools inherit|all|read-only|none | split right|down | reset]";

export type ConfigCommandResult = {
	action: "show" | "save" | "reset";
	config: BtwConfig;
};

export function applyConfigCommand(current: BtwConfig, input: string): ConfigCommandResult {
	const trimmed = input.trim();
	if (!trimmed || trimmed === "show") return { action: "show", config: current };
	if (trimmed === "reset") return { action: "reset", config: { ...DEFAULT_CONFIG } };

	const [key, value, ...extra] = trimmed.split(/\s+/);
	if (!key || !value || extra.length > 0) throw new Error(CONFIG_COMMAND_USAGE);
	const config = { ...current };

	switch (key) {
		case "auto-submit":
			if (value !== "on" && value !== "off") throw new Error(CONFIG_COMMAND_USAGE);
			config.autoSubmit = value === "on";
			break;
		case "close-on-exit":
			if (value !== "on" && value !== "off") throw new Error(CONFIG_COMMAND_USAGE);
			config.closeOnExit = value === "on";
			break;
		case "model":
			if (value !== "inherit" && !isModelName(value)) throw new Error(CONFIG_COMMAND_USAGE);
			config.model = value === "inherit" ? null : value;
			break;
		case "thinking":
			if (value !== "inherit" && !THINKING_LEVELS.includes(value as BtwThinkingLevel)) {
				throw new Error(CONFIG_COMMAND_USAGE);
			}
			config.thinking = value === "inherit" ? null : (value as BtwThinkingLevel);
			break;
		case "tools":
			if (!TOOL_MODES.includes(value as BtwToolMode)) {
				throw new Error(CONFIG_COMMAND_USAGE);
			}
			config.tools = value as BtwToolMode;
			break;
		case "split":
			if (value !== "right" && value !== "down") throw new Error(CONFIG_COMMAND_USAGE);
			config.split = value;
			break;
		default:
			throw new Error(CONFIG_COMMAND_USAGE);
	}

	return { action: "save", config };
}

export class ConfigStore {
	readonly path: string;

	constructor(path = join(getAgentDir(), "pi-herdr-btw.json")) {
		this.path = path;
	}

	async load(): Promise<BtwConfig> {
		try {
			return parseConfig(JSON.parse(await readFile(this.path, "utf8")));
		} catch (error) {
			if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
				return { ...DEFAULT_CONFIG };
			}
			throw error;
		}
	}

	async save(config: BtwConfig): Promise<void> {
		const validated = parseConfig(config);
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await chmod(temporaryPath, 0o600);
			await rename(temporaryPath, this.path);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async reset(): Promise<BtwConfig> {
		await rm(this.path, { force: true });
		return { ...DEFAULT_CONFIG };
	}
}
