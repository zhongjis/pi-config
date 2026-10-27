import type { BashDangerCode } from "./bash-policy.js";

export type Word = { text: string; start: number; quoted: boolean };
export type Boundary = { kind: "separator" | "pipe"; start: number; text: string };
export type Lexeme = Word & { kind: "word" } | Boundary;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function basename(value: string): string {
	return (value.split(/[\\/]/).pop() ?? value).toLowerCase();
}

export function optionName(value: string): string {
	return value.split("=", 1)[0];
}

export function scan(command: string, add: (code: BashDangerCode, position: number) => void): Lexeme[] {
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
			if (text === "2" && !quoted && start + 1 === index && command.slice(index, index + 3) === ">&1" &&
				(index + 3 === command.length || /[\s;|&]/.test(command[index + 3]))) {
				text = "";
				index += 2;
				continue;
			}
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

export function readRedirectionTarget(command: string, offset: number): { exactNullSink: boolean; end: number } {
	let index = offset;
	while (command[index] === " " || command[index] === "\t") index += 1;
	const start = index;
	while (index < command.length && !/[\s;&|<>]/.test(command[index])) index += 1;
	return { exactNullSink: command.slice(start, index) === "/dev/null", end: Math.max(index, offset) };
}

export function unwrap(words: Word[]): Word[] {
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

export function subcommand(words: Word[], valueOptions: Set<string>, booleanOptions: Set<string> = new Set()): Word | undefined {
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
