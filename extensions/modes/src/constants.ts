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
	kuafu: "\x1b[38;2;0;206;209m",   // #00CED1 — dark turquoise (夸父)
	fuxi: "\x1b[38;2;255;87;34m",    // #FF5722 — deep orange/fire (伏羲)
	houtu: "\x1b[38;2;16;185;129m",
};
export const RESET = "\x1b[0m";
export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
export const PLANNOTATOR_REVIEW_RESULT_CHANNEL = "plannotator:review-result";
export const PLANNOTATOR_TIMEOUT_MS = 5000;

// Read-only bash commands allowed in Fu Xi (plan) mode
export const SAFE_BASH_PREFIXES = [
	"cat ", "head ", "tail ", "less ", "more ",
	"grep ", "rg ", "find ", "fd ", "fzf ",
	"ls ", "ls\n", "pwd", "tree ", "tree\n",
	"git status", "git log", "git diff", "git branch", "git show", "git remote",
	"git rev-parse", "git describe", "git tag",
	"npm list", "npm outdated", "npm info", "npm view", "npm ls",
	"yarn info", "yarn list", "yarn why",
	"pnpm list", "pnpm outdated", "pnpm why",
	"uname", "whoami", "date", "uptime", "which ", "command -v",
	"wc ", "sort ", "uniq ", "cut ", "awk ", "sed -n", "jq ",
	"file ", "stat ", "du ", "df ",
	"echo ", "printf ",
	"nix ", "nh ",
];
