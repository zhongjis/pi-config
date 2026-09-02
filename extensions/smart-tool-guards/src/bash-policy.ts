export const BASH_DANGER_CODES = [
	"filesystem-mutation",
	"vcs-mutation",
	"external-system-mutation",
	"privilege-or-system-control",
	"output-redirection",
	"dynamic-shell-execution",
	"interpreter-execution",
	"downloaded-code-execution",
	"uninspectable-shell-syntax",
] as const;

export type BashDangerCode = (typeof BASH_DANGER_CODES)[number];

export interface BashDangerFinding {
	readonly code: BashDangerCode;
	readonly position: number;
}

export interface BashPolicyInput {
	readonly command: string;
	readonly requestedCwd?: string;
	readonly effectiveCwd: string;
	readonly requestedTimeout?: number;
}

export type BashPolicyOutcome =
	| { readonly kind: "allow" }
	| { readonly kind: "block"; readonly findings: readonly BashDangerFinding[] }
	| { readonly kind: "defer" };

type Word = { text: string; start: number; quoted: boolean };
type Boundary = { kind: "separator" | "pipe"; start: number; text: string };
type Lexeme = Word & { kind: "word" } | Boundary;

const FILESYSTEM_COMMANDS = new Set([
	"rm", "mv", "cp", "touch", "mkdir", "rmdir", "chmod", "chown", "ln", "truncate", "dd", "tee",
]);
const SHELL_COMMANDS = new Set(["bash", "sh", "dash", "zsh", "fish", "ksh", "csh", "tcsh", "eval", "source", "."]);
const INTERPRETERS = new Set([
	"python", "python2", "python3", "node", "deno", "bun", "ruby", "perl", "php", "lua", "luajit", "rscript",
]);
const PRIVILEGE_COMMANDS = new Set([
	"sudo", "doas", "su", "systemctl", "service", "launchctl", "shutdown", "reboot", "poweroff", "halt", "init", "loginctl",
]);
const GIT_MUTATIONS = new Set([
	"add", "am", "apply", "bisect", "checkout", "cherry-pick", "clean", "clone", "commit", "fetch", "gc", "init", "merge",
	"mv", "notes", "pull", "push", "rebase", "remote", "replace", "reset", "restore", "revert", "rm", "stash", "submodule",
	"switch", "tag", "worktree",
]);
const GH_MUTATING_TOP_LEVELS = new Set([
	"api", "auth", "attestation", "browse", "cache", "codespace", "completion", "config", "copilot", "extension", "gist", "gpg-key",
	"label", "org", "pr", "project", "release", "ruleset", "run", "secret", "ssh-key", "status", "variable", "workflow",
]);
const GH_MUTATING_REPO = new Set([
	"archive", "clone", "create", "delete", "deploy-key", "edit", "fork", "rename", "set-default", "sync", "unarchive",
]);
const GH_MUTATING_ISSUE = new Set([
	"close", "comment", "create", "delete", "develop", "edit", "lock", "pin", "reopen", "transfer", "unlock", "unpin",
]);
const KUBECTL_MUTATIONS = new Set([
	"annotate", "apply", "attach", "auth", "autoscale", "certificate", "config", "cordon", "cp", "create", "debug", "delete", "diff",
	"drain", "edit", "exec", "expose", "krew", "label", "patch", "plugin", "port-forward", "proxy", "replace", "rollout", "run",
	"scale", "set", "taint", "uncordon", "wait",
]);
const FLUX_MUTATIONS = new Set([
	"bootstrap", "build", "completion", "create", "delete", "install", "mcp", "pull", "push", "reconcile", "resume", "suspend", "tag", "uninstall",
]);
const KUBERNETES_VALUE_OPTIONS = new Set([
	"-n", "--namespace", "--context", "--kubeconfig", "--as", "--as-group", "--as-uid", "--cluster", "--user", "--request-timeout",
	"--timeout", "--log-level",
]);
const KUBERNETES_BOOLEAN_OPTIONS = new Set(["-A", "--all-namespaces"]);
const KUBERNETES_DANGEROUS_OPTIONS = new Set([
	"--raw", "--profile", "--profile-output", "--cache-dir", "-w", "--watch", "--watch-only", "-f", "--follow",
]);
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function basename(value: string): string {
	return (value.split(/[\\/]/).pop() ?? value).toLowerCase();
}

function optionName(value: string): string {
	return value.split("=", 1)[0];
}

function scan(command: string, add: (code: BashDangerCode, position: number) => void): Lexeme[] {
	const lexemes: Lexeme[] = [];
	let text = "";
	let start = 0;
	let quoted = false;
	let quote: "single" | "double" | undefined;

	const flush = (): void => {
		if (!text) return;
		lexemes.push({ kind: "word", text, start, quoted });
		text = "";
		quoted = false;
	};
	const begin = (position: number): void => {
		if (!text) start = position;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		const next = command[index + 1];
		if (quote === "single") {
			if (char === "'") quote = undefined;
			else text += char;
			continue;
		}
		if (quote === "double") {
			if (char === '"') {
				quote = undefined;
				continue;
			}
			if (char === "`" || char === "$" && (next === "(" || next === "{")) {
				add("uninspectable-shell-syntax", index);
			}
			if (char === "\\" && next !== undefined) {
				text += next;
				index += 1;
			} else text += char;
			continue;
		}
		if (char === "'" || char === '"') {
			begin(index);
			quoted = true;
			quote = char === "'" ? "single" : "double";
			continue;
		}
		if (char === "`" || char === "$" && (next === "(" || next === "{")) {
			add("uninspectable-shell-syntax", index);
			begin(index);
			text += char;
			continue;
		}
		if ((char === "<" || char === ">") && next === "(") {
			add("uninspectable-shell-syntax", index);
			flush();
			continue;
		}
		if (char === "<" && next === "<") {
			add("uninspectable-shell-syntax", index);
			flush();
			while (command[index + 1] === "<") index += 1;
			continue;
		}
		if (char === "\\") {
			begin(index);
			if (next === undefined || next === "\n") add("uninspectable-shell-syntax", index);
			else {
				text += next;
				index += 1;
			}
			continue;
		}
		if (/\s/.test(char)) {
			flush();
			if (char === "\n" || char === "\r") lexemes.push({ kind: "separator", start: index, text: char });
			continue;
		}
		if (char === ";" || char === "|" || char === "&") {
			if (char === "&" && next === ">") {
				flush();
				const target = readRedirectionTarget(command, index + 2);
				if (!target.exactNullSink) add("output-redirection", index);
				index = target.end - 1;
				continue;
			}
			flush();
			let operator = char;
			if ((char === "|" || char === "&") && next === char) {
				operator += next;
				index += 1;
			}
			if (char === "&" && operator === "&") add("uninspectable-shell-syntax", index);
			lexemes.push({ kind: char === "|" && operator === "|" ? "pipe" : "separator", start: index - operator.length + 1, text: operator });
			continue;
		}
		if (char === ">") {
			if (/^\d+$/.test(text) && start + text.length === index) text = "";
			flush();
			let offset = index + 1;
			if (command[offset] === ">" || command[offset] === "|") offset += 1;
			const target = readRedirectionTarget(command, offset);
			if (!target.exactNullSink) add("output-redirection", index);
			index = target.end - 1;
			continue;
		}
		begin(index);
		text += char;
	}
	flush();
	if (quote) add("uninspectable-shell-syntax", command.length - 1);
	return lexemes;
}

function readRedirectionTarget(command: string, offset: number): { exactNullSink: boolean; end: number } {
	let index = offset;
	while (command[index] === " " || command[index] === "\t") index += 1;
	const start = index;
	while (index < command.length && !/[\s;&|<>]/.test(command[index])) index += 1;
	return { exactNullSink: command.slice(start, index) === "/dev/null", end: Math.max(index, offset) };
}

function unwrap(words: Word[]): Word[] {
	let index = 0;
	while (ASSIGNMENT.test(words[index]?.text ?? "")) index += 1;
	for (;;) {
		const name = basename(words[index]?.text ?? "");
		if (name === "env") {
			index += 1;
			while (index < words.length) {
				const value = words[index].text;
				if (value === "--") { index += 1; break; }
				if (value === "-u" || value === "--unset" || value === "-C" || value === "--chdir") index += 2;
				else if (value.startsWith("-") || ASSIGNMENT.test(value)) index += 1;
				else break;
			}
			continue;
		}
		if (name === "command") {
			index += 1;
			if (["-v", "-V"].includes(words[index]?.text ?? "")) return [];
			while (words[index]?.text === "-p" || words[index]?.text === "--") index += 1;
			continue;
		}
		if (name === "nohup") {
			index += 1;
			while (words[index]?.text.startsWith("-") && words[index]?.text !== "--") index += 1;
			if (words[index]?.text === "--") index += 1;
			continue;
		}
		break;
	}
	return words.slice(index);
}

function subcommand(words: Word[], valueOptions: Set<string>, booleanOptions: Set<string> = new Set()): Word | undefined {
	for (let index = 1; index < words.length; index += 1) {
		const value = words[index].text;
		const option = optionName(value);
		if (booleanOptions.has(option)) continue;
		if (valueOptions.has(option)) {
			if (!value.includes("=")) index += 1;
			continue;
		}
		if (value.startsWith("-")) continue;
		return words[index];
	}
	return undefined;
}

function isExactAgentBrowserReadOnly(words: Word[]): boolean {
	const keyword = (index: number, value: string): boolean => words[index]?.text === value && !words[index]?.quoted;
	const value = (index: number): boolean => words[index] !== undefined && !words[index].text.startsWith("-");
	if (!keyword(0, "agent-browser")) return false;

	if (words.length === 2 && ["--help", "-h", "--version", "-V"].some((flag) => keyword(1, flag))) return true;
	if (words.length === 3 && value(1) && ["--help", "-h"].some((flag) => keyword(2, flag))) return true;

	if (words.length === 2 && ["snapshot", "read", "cookies", "tab", "console", "errors", "session", "profiles"].some((command) => keyword(1, command))) return true;
	if (words.length === 3 && (
		["title", "url", "cdp-url"].some((command) => keyword(1, "get") && keyword(2, command)) ||
		keyword(2, "list") && ["tab", "session", "device", "auth"].some((command) => keyword(1, command)) ||
		["local", "session"].some((scope) => keyword(1, "storage") && keyword(2, scope)) ||
		keyword(1, "clipboard") && keyword(2, "read") ||
		keyword(1, "dialog") && keyword(2, "status") ||
		keyword(1, "stream") && keyword(2, "status") ||
		keyword(1, "webmcp") && keyword(2, "list") ||
		keyword(1, "react") && ["tree", "suspense"].some((action) => keyword(2, action)) ||
		keyword(1, "snapshot") && ["-i", "--json"].some((flag) => keyword(2, flag)) ||
		keyword(2, "--json") && ["console", "profiles"].some((command) => keyword(1, command))
	)) return true;

	if (keyword(1, "get")) {
		if (words.length === 4 && ["text", "html", "value", "count", "box", "styles"].some((action) => keyword(2, action)) && value(3)) return true;
		if (words.length === 5 && keyword(2, "attr") && value(3) && value(4)) return true;
	}
	if (words.length === 4 && keyword(1, "is") && ["visible", "enabled", "checked"].some((action) => keyword(2, action)) && value(3)) return true;
	if (words.length === 5 && keyword(1, "find") && value(2) && value(3) && keyword(4, "text")) return true;
	if (keyword(1, "wait")) {
		if (words.length === 3 && value(2)) return true;
		if (words.length === 4 && ["--text", "--url", "--load"].some((flag) => keyword(2, flag)) && value(3)) return true;
	}
	if (words.length === 3 && keyword(1, "network") && keyword(2, "requests")) return true;
	if (words.length === 5 && keyword(1, "network") && keyword(2, "requests") && ["--filter", "--type", "--method", "--status"].some((flag) => keyword(3, flag)) && value(4)) return true;
	if (words.length === 4 && keyword(1, "network") && keyword(2, "request") && value(3)) return true;
	if (words.length === 4 && keyword(1, "tab") && keyword(2, "list") && keyword(3, "--json")) return true;
	if (words.length === 4 && keyword(1, "storage") && ["local", "session"].some((scope) => keyword(2, scope)) && value(3) && !["set", "clear"].includes(words[3].text)) return true;
	if (words.length === 4 && keyword(1, "auth") && keyword(2, "show") && value(3)) return true;
	if (words.length === 4 && ["plugin", "state"].some((command) => keyword(1, command)) && keyword(2, "show") && value(3)) return true;
	if (words.length === 3 && ["plugin", "state"].some((command) => keyword(1, command)) && keyword(2, "list")) return true;
	if (words.length === 4 && keyword(1, "react") && keyword(2, "inspect") && value(3)) return true;
	if (words.length === 4 && keyword(1, "react") && keyword(2, "suspense") && ["--only-dynamic", "--json"].some((flag) => keyword(3, flag))) return true;
	if (words.length === 5 && keyword(1, "react") && keyword(2, "suspense") && new Set(words.slice(3).map((word) => word.text)).size === 2 && words.slice(3).every((word) => !word.quoted && ["--only-dynamic", "--json"].includes(word.text))) return true;
	return false;
}

function inspectCommand(words: Word[], add: (code: BashDangerCode, position: number) => void): { name: string; position: number } | undefined {
	const argv = unwrap(words);
	const executable = argv[0];
	if (!executable) return undefined;
	const name = basename(executable.text);
	if (FILESYSTEM_COMMANDS.has(name)) add("filesystem-mutation", executable.start);
	if (SHELL_COMMANDS.has(name)) add("dynamic-shell-execution", executable.start);
	if (INTERPRETERS.has(name)) add("interpreter-execution", executable.start);
	if (PRIVILEGE_COMMANDS.has(name)) add("privilege-or-system-control", executable.start);

	if (name === "git") {
		const action = subcommand(argv, GIT_VALUE_OPTIONS);
		if (action && (GIT_MUTATIONS.has(action.text.toLowerCase()) ||
			action.text.toLowerCase() === "branch" && argv.slice(argv.indexOf(action) + 1).some((word) => ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "--set-upstream-to", "--unset-upstream", "--edit-description"].includes(optionName(word.text))) ||
			["diff", "show"].includes(action.text.toLowerCase()) && argv.slice(argv.indexOf(action) + 1).some((word) => optionName(word.text) === "--output"))) {
			add("vcs-mutation", action.start);
		}
	}
	if (name === "gh") {
		const top = argv[1]?.text.toLowerCase();
		const nested = argv[2]?.text.toLowerCase();
		if (top && (GH_MUTATING_TOP_LEVELS.has(top) || top === "repo" && nested !== undefined && GH_MUTATING_REPO.has(nested) ||
			top === "issue" && nested !== undefined && GH_MUTATING_ISSUE.has(nested) || argv.slice(1).some((word) => ["--web", "-w"].includes(optionName(word.text))))) {
			add("vcs-mutation", argv[1]?.start ?? executable.start);
		}
	}
	if (name === "kubectl" || name === "flux") {
		const action = subcommand(argv, KUBERNETES_VALUE_OPTIONS, KUBERNETES_BOOLEAN_OPTIONS);
		const mutationSet = name === "kubectl" ? KUBECTL_MUTATIONS : FLUX_MUTATIONS;
		if (action && mutationSet.has(action.text.toLowerCase()) || argv.slice(1).some((word) => KUBERNETES_DANGEROUS_OPTIONS.has(optionName(word.text)))) {
			add("external-system-mutation", action?.start ?? executable.start);
		}
	}
	return { name, position: executable.start };
}

export function evaluateBashPolicy(input: BashPolicyInput): BashPolicyOutcome {
	const earliest = new Map<BashDangerCode, number>();
	const add = (code: BashDangerCode, position: number): void => {
		const previous = earliest.get(code);
		if (previous === undefined || position < previous) earliest.set(code, Math.max(0, position));
	};
	const lexemes = scan(input.command, add);
	const stages: Word[][] = [[]];
	const pipelineGroups: number[][] = [[0]];
	let group = 0;
	for (const lexeme of lexemes) {
		if (lexeme.kind === "word") stages.at(-1)?.push(lexeme);
		else {
			if (lexeme.kind === "pipe") pipelineGroups[group].push(stages.length);
			else { group += 1; pipelineGroups.push([stages.length]); }
			stages.push([]);
		}
	}
	lexemes.forEach((lexeme, index) => {
		if (lexeme.kind === "pipe" && (!lexemes[index - 1] || lexemes[index - 1].kind !== "word" || !lexemes[index + 1] || lexemes[index + 1].kind !== "word")) {
			add("uninspectable-shell-syntax", lexeme.start);
		}
		if (lexeme.kind === "separator" && lexeme.text !== ";" && lexeme.text !== "\n" && lexeme.text !== "\r" &&
			(!lexemes[index - 1] || lexemes[index - 1].kind !== "word" || !lexemes[index + 1] || lexemes[index + 1].kind !== "word")) {
			add("uninspectable-shell-syntax", lexeme.start);
		}
	});
	const commands = stages.map((stage) => inspectCommand(stage, add));
	for (const indexes of pipelineGroups) {
		const downloader = indexes.map((index) => commands[index]).find((command) => command && ["curl", "wget"].includes(command.name));
		const executor = indexes.map((index) => commands[index]).find((command) => command && (SHELL_COMMANDS.has(command.name) || INTERPRETERS.has(command.name)));
		if (downloader && executor) add("downloaded-code-execution", downloader.position);
	}
	const findings = [...earliest].map(([code, position]) => ({ code, position })).sort((left, right) =>
		left.position - right.position || BASH_DANGER_CODES.indexOf(left.code) - BASH_DANGER_CODES.indexOf(right.code));
	if (findings.length > 0) return { kind: "block", findings };
	if (input.command.trim() === "pwd" || stages.length === 1 && isExactAgentBrowserReadOnly(stages[0])) return { kind: "allow" };
	return { kind: "defer" };
}
