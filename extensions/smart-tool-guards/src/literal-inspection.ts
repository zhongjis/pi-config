// Unlike the hazard scanner, literal matching preserves empty arguments and shell spelling.
function literalStages(command: string, pipeline: boolean): string[][] | undefined {
	const stages: string[][] = [[]];
	const literalWordPattern = /(?:[^\s'"\\$`*?[\]{}~#!();&|<>]|'[^']*'|"(?:[^"\\$`]|\\["\\$`])*"|\\[^\n\r]|(?<=[A-Za-z0-9_./^~-])~)+/y;
	let index = 0;
	while (index < command.length) {
		while (command[index] === " " || command[index] === "\t") index += 1;
		if (index === command.length) break;
		if (pipeline && command[index] === "|") {
			if (stages.at(-1)?.length === 0) return undefined;
			stages.push([]);
			index += 1;
			continue;
		}
		literalWordPattern.lastIndex = index;
		const match = literalWordPattern.exec(command);
		if (!match) return undefined;
		// Only unquoted, direct executable names enter the inspection fast path.
		if (pipeline && stages.at(-1)?.length === 0 && !/^[a-z][a-z0-9-]*$/.test(match[0])) return undefined;
		stages.at(-1)?.push(match[0].replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/gs,
			(_chunk, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
				single ?? (double === undefined ? escaped ?? "" : double.replace(/\\(["\\$`])/g, "$1"))));
		index = literalWordPattern.lastIndex;
		if (index < command.length && command[index] !== " " && command[index] !== "\t" && !(pipeline && command[index] === "|")) return undefined;
	}
	return stages.at(-1)?.length ? stages : undefined;
}

export function literalWords(command: string): string[] | undefined {
	return literalStages(command, false)?.[0];
}

type Options = {
	readonly flags: readonly string[];
	readonly values?: readonly string[];
	readonly numeric?: readonly string[];
};

const READER_OPTIONS: Readonly<Record<string, Options>> = {
	cat: { flags: ["-n", "-b", "-s", "-v", "-E", "-T", "-A"] },
	nl: { flags: [] },
	head: { flags: ["-q", "-v"], numeric: ["-n", "-c", "--lines", "--bytes"] },
	tail: { flags: ["-q", "-v"], numeric: ["-n", "-c", "--lines", "--bytes"] },
	wc: { flags: ["-l", "-w", "-c", "-m", "-L"] },
	sha256sum: { flags: ["-b", "-t", "--binary", "--text", "--tag"] },
	rg: {
		flags: ["--no-config", "--files", "--hidden", "-n", "--line-number", "-i", "--ignore-case", "-l", "--files-with-matches", "-c", "--count", "-F", "--fixed-strings", "-w", "--word-regexp", "-S", "--smart-case"],
		values: ["-e", "--regexp", "-g", "--glob", "-t", "--type", "-T", "--type-not"],
		numeric: ["-A", "--after-context", "-B", "--before-context", "-C", "--context", "-m", "--max-count", "--max-depth"],
	},
	fd: {
		flags: ["--hidden", "-H", "--no-ignore", "-I", "--absolute-path", "-a", "--full-path", "-p", "--fixed-strings", "-F", "--case-sensitive", "-s", "--ignore-case", "-i"],
		values: ["-t", "--type", "-e", "--extension", "-E", "--exclude", "--search-path"],
		numeric: ["-d", "--max-depth"],
	},
	git: {
		flags: ["--cached", "--staged", "--stat", "--numstat", "--name-only", "--name-status", "--check", "--no-color", "--no-ext-diff", "--no-textconv"],
		numeric: ["-U", "--unified"],
	},
} as const;

function inspectionStage(words: readonly string[]): boolean {
	const rtkDiff = words[0] === "rtk" && words[1] === "git" && words[2] === "diff";
	const [executable, ...args] = rtkDiff ? words.slice(1) : words;
	if (args.some((arg) => arg.length === 0)) return false;
	if (executable === "git" && args.shift() !== "diff") return false;
	if (executable === "jq") return args.length === 1 && ["--version", "--help"].includes(args[0]);
	if (executable === "command") return args.length === 2 && args[0] === "-v" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(args[1]);
	if (!Object.hasOwn(READER_OPTIONS, executable)) return false;
	const options = READER_OPTIONS[executable];
	let configDisabled = false;
	let operands = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (operands || arg === "-" || !arg.startsWith("-")) continue;
		if (arg === "--") { operands = true; continue; }
		if (options.flags.includes(arg)) {
			if (arg === "--no-config") configDisabled = true;
			continue;
		}
		if (rtkDiff && arg === "--no-compact") continue;
		if (["head", "tail"].includes(executable) && /^-\d+$/.test(arg)) continue;
		const compact = /^(-[A-Za-z])(\d+)$/.exec(arg);
		if (compact && options.numeric?.includes(compact[1])) continue;
		const equals = arg.indexOf("=");
		const flag = equals < 0 ? arg : arg.slice(0, equals);
		const numeric = options.numeric?.includes(flag);
		if (!numeric && !options.values?.includes(flag)) return false;
		const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
		if (!value || value.startsWith("-") || numeric && !/^\d+$/.test(value)) return false;
	}
	return executable !== "rg" || configDisabled;
}

export function isLiteralInspection(command: string): boolean {
	// This is the only compound-command exception; no arbitrary fallback stage is accepted.
	if (/^[ \t]*command[ \t]+-v[ \t]+[A-Za-z_][A-Za-z0-9_-]*[ \t]+\|\|[ \t]+true[ \t]*$/.test(command)) return true;
	const stages = literalStages(command, true);
	return stages !== undefined && stages.every(inspectionStage);
}
