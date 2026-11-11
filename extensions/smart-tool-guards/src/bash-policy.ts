import { isCommandDiscoveryFallback, literalStages, literalWords } from "./literal-inspection.js";
import { scan, unwrap, subcommand, basename, optionName, type Word } from "./bash-syntax.js";
import type { ApprovalRule, ArgvElement, DenialRule, GuardProfile, LiteralRule, ValueSpec } from "./profile.js";

/** A profile deny effect or a code-owned shell-structure code. */
export type BashDangerCode = string;

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

// Shell-structure findings are code-owned for every profile; profiles cannot configure them.
const STRUCTURAL_CODES = ["output-redirection", "downloaded-code-execution", "uninspectable-shell-syntax"] as const;
const DOWNLOADERS = new Set(["curl", "wget"]);
const CODE_RUNNERS = new Set([
	"bash", "sh", "dash", "zsh", "fish", "ksh", "csh", "tcsh", "eval", "source", ".",
	"python", "python2", "python3", "node", "deno", "bun", "ruby", "perl", "php", "lua", "luajit", "rscript",
]);

/** A shell segment's argv without assignments or known wrappers; RTK Git keeps Git's hazards without making RTK a general wrapper. */
function segmentArgv(words: Word[]): Word[] {
	const unwrapped = unwrap(words);
	return basename(unwrapped[0]?.text ?? "") === "rtk" && unwrapped[1]?.text === "git" ? unwrapped.slice(1) : unwrapped;
}

/** Where a matching denial is reported: rules that inspect past the executable point at its subcommand. */
function denialPosition(rule: DenialRule, argv: Word[]): number | undefined {
	const [executable] = argv;
	if (!executable || !rule.argv[0].includes(basename(executable.text))) return undefined;
	const action = rule.globalOptions ? subcommand(argv, rule.globalOptions) : argv[1];
	const start = action ? argv.indexOf(action) : argv.length;
	if (rule.argv.slice(1).some((words, index) => {
		const word = argv[start + index];
		return !word || !words.includes(word.text.toLowerCase());
	})) return undefined;
	if (rule.anyOption) {
		const rest = argv.slice(rule.argv.length > 1 ? start + rule.argv.length - 1 : 1);
		const separator = rule.operands ? rest.findIndex((word) => word.text === "--") : -1;
		const options = separator < 0 ? rest : rest.slice(0, separator);
		if (!options.some((word) => rule.anyOption?.has(optionName(word.text)))) return undefined;
	}
	return rule.argv.length > 1 || rule.anyOption ? (action ?? executable).start : executable.start;
}

type Token = Pick<Word, "text" | "quoted">;

function valueMatches(spec: ValueSpec, value: string | undefined, signed: boolean): boolean {
	// Do not swallow another option as a value unless signed integers are valid values.
	if (!value || value.startsWith("-") && !(signed && /^-\d+$/.test(value))) return false;
	if (spec.int && !/^\d+$/.test(value)) return false;
	if (spec.enum && !spec.enum.includes(value)) return false;
	if (spec.pattern && !spec.pattern.test(value)) return false;
	return spec.max === undefined || Number(value) <= spec.max;
}

/** Matches the leading tokens; keywords never match quoted tokens. */
function matchesArgv(argv: readonly ArgvElement[], tokens: readonly Token[]): boolean {
	return argv.every((element, index) => {
		const token = tokens[index];
		if (!token) return false;
		switch (element.kind) {
			case "keyword": return !token.quoted && element.words.includes(token.text);
			case "value": return valueMatches(element.spec, token.text, false);
			default: {
				const unreachable: never = element;
				return unreachable;
			}
		}
	});
}

function matchesOptions(rule: LiteralRule, args: readonly string[]): boolean {
	const seen = new Set<string>();
	let operandsOnly = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (operandsOnly || rule.operands && (arg === "-" || !arg.startsWith("-"))) continue;
		if (rule.operands && arg === "--") {
			operandsOnly = true;
			continue;
		}
		if (rule.countShorthand && /^-\d+$/.test(arg)) continue;
		let name = arg;
		if (rule.options.get(arg)?.kind !== "flag") {
			const compact = /^(-[A-Za-z])(\d+)$/.exec(arg);
			const compactOption = compact ? rule.options.get(compact[1]) : undefined;
			if (compact && compactOption?.kind === "value" && compactOption.spec.int) name = compact[1];
			else {
				const equals = rule.equals ? arg.indexOf("=") : -1;
				name = equals < 0 ? arg : arg.slice(0, equals);
				const option = rule.options.get(name);
				const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
				if (option?.kind !== "value" || !valueMatches(option.spec, value, rule.signedValues)) return false;
			}
		}
		if (rule.unique.has(name) && seen.has(name)) return false;
		seen.add(name);
	}
	return rule.require.every((name) => seen.has(name)) &&
		(rule.requireOneOf.length === 0 || rule.requireOneOf.some((name) => seen.has(name)));
}

function matchesLiteral(rule: LiteralRule, words: readonly string[]): boolean {
	// Literal views compare dequoted text, so their keywords treat every token as unquoted.
	const tokens = words.map((text) => ({ text, quoted: false }));
	return words.every((word) => word.length > 0) && matchesArgv(rule.argv, tokens) &&
		matchesOptions(rule, words.slice(rule.argv.length));
}

/** The lexical views of one command that approval rules match. */
type CommandViews = {
	readonly text: string;
	readonly shell: readonly Word[][];
	readonly literal: readonly string[][] | undefined;
};

function matchesCommand(rule: ApprovalRule, views: CommandViews): boolean {
	switch (rule.on) {
		case "text": return views.text.trim() === rule.text;
		case "words": return views.shell.length === 1 && views.shell[0].length === rule.argv.length && matchesArgv(rule.argv, views.shell[0]);
		case "command": {
			const words = rule.quotedExecutable ? literalWords(views.text) : views.literal?.length === 1 ? views.literal[0] : undefined;
			return words !== undefined && matchesLiteral(rule, words);
		}
		case "stage": return false;
		default: {
			const unreachable: never = rule;
			return unreachable;
		}
	}
}

/** Whole-command approval, plus which shell segments an approval rule matched. */
function approve(profile: GuardProfile, command: string, shellStages: readonly Word[][]): { readonly command: boolean; readonly segments: readonly boolean[] } {
	const views: CommandViews = { text: command, shell: shellStages, literal: literalStages(command, true) };
	const stages = views.literal?.map((words) => profile.approvals.some((rule) => rule.on === "stage" && matchesLiteral(rule, words))) ?? [];
	const whole = isCommandDiscoveryFallback(command) || stages.length > 0 && stages.every(Boolean) ||
		profile.approvals.some((rule) => matchesCommand(rule, views));
	// An accepted literal pipeline has one literal stage per shell segment.
	return { command: whole, segments: shellStages.map((_, index) => whole || stages[index] === true) };
}

export function evaluateBashPolicy(profile: GuardProfile, input: BashPolicyInput): BashPolicyOutcome {
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
	const approval = approve(profile, input.command, stages);
	const executables = stages.map((stage, index) => {
		const argv = segmentArgv(stage);
		for (const rule of profile.denials) {
			// Fallback denials cover an executable only where no approval rule matched its segment.
			if (rule.fallback && approval.segments[index]) continue;
			const position = denialPosition(rule, argv);
			if (position !== undefined) add(rule.effect, position);
		}
		return argv[0] && { name: basename(argv[0].text), position: argv[0].start };
	});
	for (const indexes of pipelineGroups) {
		const downloader = indexes.map((index) => executables[index]).find((command) => command && DOWNLOADERS.has(command.name));
		const runner = indexes.map((index) => executables[index]).find((command) => command && CODE_RUNNERS.has(command.name));
		if (downloader && runner) add("downloaded-code-execution", downloader.position);
	}
	const rank: readonly string[] = [...new Set(profile.denials.map(({ effect }) => effect)), ...STRUCTURAL_CODES];
	const findings = [...earliest].map(([code, position]) => ({ code, position })).sort((left, right) =>
		left.position - right.position || rank.indexOf(left.code) - rank.indexOf(right.code));
	if (findings.length > 0) return { kind: "block", findings };
	if (approval.command) return { kind: "allow" };
	return { kind: "defer" };
}
