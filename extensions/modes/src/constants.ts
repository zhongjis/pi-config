import type { Mode } from "./types.js";

export const MODES: Mode[] = ["kuafu", "fuxi", "houtu"];

export const MODE_ALIASES: Record<string, Mode> = {
	build: "kuafu",
	plan: "fuxi",
	execute: "houtu",
};

export const MODE_META: Record<Mode, { alias: string; label: string }> = {
	kuafu: { alias: "build", label: "Kua Fu 夸父 (build)" },
	fuxi: { alias: "plan", label: "Fu Xi 伏羲 (plan)" },
	houtu: { alias: "execute", label: "Hou Tu 后土 (execute)" },
};

// Color scheme (24-bit ANSI)
export const MODE_COLORS: Record<Mode, string> = {
	kuafu: "\x1b[38;2;0;206;209m", // #00CED1 — dark turquoise (夸父)
	fuxi: "\x1b[38;2;255;87;34m", // #FF5722 — deep orange/fire (伏羲)
	houtu: "\x1b[38;2;16;185;129m",
};

export const RESET = "\x1b[0m";

// Plan file constants
export const PLAN_FILE_NAME = "PLAN.md";
export const LOCAL_PLAN_URI = `local://${PLAN_FILE_NAME}`;

export const DRAFT_FILE_NAME = "DRAFT.md";
export const LOCAL_DRAFT_URI = `local://${DRAFT_FILE_NAME}`;
