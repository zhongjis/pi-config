import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { GUARD_PROFILE_IDS } from "../../lib/guard-registration.js";

/** Profiles are read only from this extension's own directory, never from project or user paths. */
const PROFILE_DIR = new URL("../profiles/", import.meta.url);

export type ValueSpec = {
	/** Decimal digits only; a short option also accepts the compact `-X123` form. */
	readonly int: boolean;
	readonly enum?: readonly string[];
	readonly pattern?: RegExp;
	readonly max?: number;
};
export type ArgvElement =
	| { readonly kind: "keyword"; readonly words: readonly string[] }
	| { readonly kind: "value"; readonly spec: ValueSpec };
export type OptionSpec = { readonly kind: "flag" } | { readonly kind: "value"; readonly spec: ValueSpec };

export type LiteralRule = {
	readonly on: "stage" | "command";
	readonly argv: readonly ArgvElement[];
	readonly quotedExecutable: boolean;
	readonly options: ReadonlyMap<string, OptionSpec>;
	readonly operands: boolean;
	readonly equals: boolean;
	readonly signedValues: boolean;
	readonly countShorthand: boolean;
	readonly require: readonly string[];
	readonly requireOneOf: readonly string[];
	readonly unique: ReadonlySet<string>;
};
export type ApprovalRule =
	| { readonly on: "text"; readonly text: string }
	| { readonly on: "words"; readonly argv: readonly ArgvElement[] }
	| LiteralRule;
export type DenialRule = {
	readonly effect: string;
	readonly argv: readonly (readonly string[])[];
	readonly globalOptions?: ReadonlySet<string>;
	readonly anyOption?: ReadonlySet<string>;
	readonly operands: boolean;
	readonly fallback: boolean;
};

export interface GuardProfile {
	readonly id: string;
	readonly approvals: readonly ApprovalRule[];
	/** In file order; the first appearance of an effect sets its rank among same-position findings. */
	readonly denials: readonly DenialRule[];
	readonly classifier: {
		readonly instructions: string;
		readonly choices: { readonly allow: string; readonly criteria: Readonly<Record<string, string>> };
	};
}

export type GuardProfileLoad =
	| { readonly kind: "loaded"; readonly profile: GuardProfile }
	| { readonly kind: "invalid"; readonly error: string };

class ProfileError extends Error {
	readonly name = "ProfileError";
}

const VIEWS = ["segment", "stage", "command", "words", "text"] as const;
type View = (typeof VIEWS)[number];
const LITERAL_KEYS = [
	"argv", "flags", "values", "ints", "operands", "equals", "signed_values", "count_shorthand", "require", "require_one_of", "unique",
] as const;
const VIEW_KEYS: Readonly<Record<View, readonly string[]>> = {
	segment: ["argv", "global_options", "any_option", "operands", "fallback"],
	stage: LITERAL_KEYS,
	command: [...LITERAL_KEYS, "quoted_executable"],
	words: ["argv"],
	text: ["text"],
};

type Parsed = { readonly kind: "approval"; readonly rule: ApprovalRule } | { readonly kind: "denial"; readonly rule: DenialRule };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isView(value: unknown): value is View {
	return VIEWS.some((view) => view === value);
}

function fields(value: unknown, path: string, keys?: readonly string[]): Readonly<Record<string, unknown>> {
	if (!isRecord(value) || Object.keys(value).length === 0) throw new ProfileError(`${path} must be a non-empty mapping.`);
	const unknownKey = keys && Object.keys(value).find((key) => !keys.includes(key));
	if (unknownKey !== undefined) throw new ProfileError(`${path}.${unknownKey} is not a known key.`);
	return value;
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new ProfileError(`${path} must be a non-blank string.`);
	return value;
}

function texts(value: unknown, path: string): readonly string[] {
	if (!Array.isArray(value) || value.length === 0) throw new ProfileError(`${path} must be a non-empty list.`);
	return value.map((item, index) => text(item, `${path}[${index}]`));
}

function optionalTexts(value: unknown, path: string): readonly string[] {
	return value === undefined ? [] : texts(value, path);
}

function optionalSet(value: unknown, path: string): ReadonlySet<string> | undefined {
	return value === undefined ? undefined : new Set(texts(value, path));
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new ProfileError(`${path} must be a boolean.`);
	return value;
}

function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new ProfileError(`${path} must be a finite number.`);
	return value;
}

function pattern(value: unknown, path: string): RegExp {
	try {
		return new RegExp(text(value, path));
	} catch (error) {
		if (error instanceof SyntaxError) throw new ProfileError(`${path} is not a valid regular expression.`);
		throw error;
	}
}

function valueSpec(value: unknown, path: string): ValueSpec {
	if (isRecord(value) && Object.keys(value).length === 0) return { int: false };
	const spec = fields(value, path, ["enum", "pattern", "max"]);
	return {
		int: false,
		enum: spec.enum === undefined ? undefined : texts(spec.enum, `${path}.enum`),
		pattern: spec.pattern === undefined ? undefined : pattern(spec.pattern, `${path}.pattern`),
		max: spec.max === undefined ? undefined : finiteNumber(spec.max, `${path}.max`),
	};
}

function keywords(value: unknown, path: string): readonly string[] | undefined {
	if (typeof value === "string") return [text(value, path)];
	return Array.isArray(value) ? texts(value, path) : undefined;
}

function argv(value: unknown, path: string): readonly ArgvElement[] {
	if (!Array.isArray(value) || value.length === 0) throw new ProfileError(`${path} must be a non-empty list.`);
	const elements = value.map((item, index): ArgvElement => {
		const words = keywords(item, `${path}[${index}]`);
		return words ? { kind: "keyword", words } : { kind: "value", spec: valueSpec(item, `${path}[${index}]`) };
	});
	if (elements[0].kind !== "keyword") throw new ProfileError(`${path}[0] must name the executable.`);
	return elements;
}

function valueOptions(value: unknown, path: string): readonly (readonly [string, OptionSpec])[] {
	if (value === undefined) return [];
	if (Array.isArray(value)) return texts(value, path).map((name) => [name, { kind: "value", spec: { int: false } }] as const);
	return Object.entries(fields(value, path)).map(([name, spec]) => [name, { kind: "value", spec: valueSpec(spec, `${path}.${name}`) }] as const);
}

function options(rule: Readonly<Record<string, unknown>>, path: string): ReadonlyMap<string, OptionSpec> {
	const entries: readonly (readonly [string, OptionSpec])[] = [
		...optionalTexts(rule.flags, `${path}.flags`).map((name) => [name, { kind: "flag" }] as const),
		...optionalTexts(rule.ints, `${path}.ints`).map((name) => [name, { kind: "value", spec: { int: true } }] as const),
		...valueOptions(rule.values, `${path}.values`),
	];
	const declared = new Map(entries);
	if (declared.size !== entries.length) throw new ProfileError(`${path} declares an option more than once.`);
	return declared;
}

function references(value: unknown, path: string, declared: ReadonlyMap<string, OptionSpec>): readonly string[] {
	const names = optionalTexts(value, path);
	const undeclared = names.find((name) => !declared.has(name));
	if (undeclared !== undefined) throw new ProfileError(`${path} names undeclared option ${undeclared}.`);
	return names;
}

function parseRule(value: unknown, path: string, allow: readonly string[]): Parsed {
	const on = isRecord(value) ? value.on : undefined;
	if (!isView(on)) throw new ProfileError(`${path}.on must be one of ${VIEWS.join(", ")}.`);
	const rule = fields(value, path, ["effect", "on", ...VIEW_KEYS[on]]);
	const effect = text(rule.effect, `${path}.effect`);
	// Segment rules deny; every other view approves. A mismatched effect is a profile error, not a silent no-op.
	if ((on === "segment") === allow.includes(effect)) {
		throw new ProfileError(`${path}.effect ${effect} ${on === "segment" ? "is allowed, so a segment rule cannot deny it" : "is not allowed by this profile"}.`);
	}
	switch (on) {
		case "segment": {
			const prefix = Array.isArray(rule.argv) ? rule.argv.map((item, index) => keywords(item, `${path}.argv[${index}]`)) : [];
			const words = prefix.filter((item): item is readonly string[] => item !== undefined);
			if (words.length === 0 || words.length !== prefix.length) {
				throw new ProfileError(`${path}.argv must be a non-empty list of keywords.`);
			}
			return {
				kind: "denial",
				rule: {
					effect,
					argv: words,
					globalOptions: optionalSet(rule.global_options, `${path}.global_options`),
					anyOption: optionalSet(rule.any_option, `${path}.any_option`),
					operands: bool(rule.operands, `${path}.operands`, false),
					fallback: bool(rule.fallback, `${path}.fallback`, false),
				},
			};
		}
		case "stage":
		case "command": {
			const declared = options(rule, path);
			return {
				kind: "approval",
				rule: {
					on,
					argv: argv(rule.argv, `${path}.argv`),
					quotedExecutable: bool(rule.quoted_executable, `${path}.quoted_executable`, false),
					options: declared,
					operands: bool(rule.operands, `${path}.operands`, false),
					equals: bool(rule.equals, `${path}.equals`, true),
					signedValues: bool(rule.signed_values, `${path}.signed_values`, false),
					countShorthand: bool(rule.count_shorthand, `${path}.count_shorthand`, false),
					require: references(rule.require, `${path}.require`, declared),
					requireOneOf: references(rule.require_one_of, `${path}.require_one_of`, declared),
					unique: new Set(references(rule.unique, `${path}.unique`, declared)),
				},
			};
		}
		case "words":
			return { kind: "approval", rule: { on, argv: argv(rule.argv, `${path}.argv`) } };
		case "text":
			return { kind: "approval", rule: { on, text: text(rule.text, `${path}.text`) } };
		default: {
			const unreachable: never = on;
			throw new ProfileError(`${path}.on ${String(unreachable)} is not supported.`);
		}
	}
}

/** Parses one profile document; any unknown key, wrong type, or inconsistent rule makes the whole profile invalid. */
export function parseGuardProfile(id: string, source: string): GuardProfileLoad {
	try {
		const document = parseDocument(source, {
			customTags: [],
			merge: false,
			resolveKnownTags: false,
			schema: "core",
			stringKeys: true,
			uniqueKeys: true,
			version: "1.2",
		});
		const problems = [...document.errors, ...document.warnings];
		if (problems.length > 0) throw new ProfileError(`Invalid YAML: ${problems.map(({ message }) => message).join(" ")}`);
		const root = fields(document.toJS(), "profile", ["allow", "unmatched", "classifier", "rules"]);
		const allow = texts(root.allow, "allow");
		if (root.unmatched !== "classifier") throw new ProfileError("unmatched must be classifier.");
		const classifier = fields(root.classifier, "classifier", ["instructions", "choices"]);
		const choices = fields(classifier.choices, "classifier.choices", ["allow", "criteria"]);
		const criteria = Object.fromEntries(Object.entries(fields(choices.criteria, "classifier.choices.criteria"))
			.map(([label, criterion]) => [label, text(criterion, `classifier.choices.criteria.${label}`)]));
		const allowLabel = text(choices.allow, "classifier.choices.allow");
		if (!Object.hasOwn(criteria, allowLabel)) throw new ProfileError("classifier.choices.allow must name a criteria label.");
		if (!Array.isArray(root.rules) || root.rules.length === 0) throw new ProfileError("rules must be a non-empty list.");
		const rules = root.rules.map((rule, index) => parseRule(rule, `rules[${index}]`, allow));
		return {
			kind: "loaded",
			profile: {
				id,
				approvals: rules.flatMap((parsed) => parsed.kind === "approval" ? [parsed.rule] : []),
				denials: rules.flatMap((parsed) => parsed.kind === "denial" ? [parsed.rule] : []),
				classifier: {
					instructions: text(classifier.instructions, "classifier.instructions"),
					choices: { allow: allowLabel, criteria },
				},
			},
		};
	} catch (error) {
		if (error instanceof ProfileError) return { kind: "invalid", error: `Guard profile ${id}: ${error.message}` };
		throw error;
	}
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/** Loads `profiles/<id>.yaml`; unknown, unreadable, or invalid profiles fail closed. */
export function loadGuardProfile(id: string): GuardProfileLoad {
	if (!GUARD_PROFILE_IDS.includes(id)) return { kind: "invalid", error: `Guard profile ${id} does not exist.` };
	try {
		return parseGuardProfile(id, readFileSync(new URL(`${id}.yaml`, PROFILE_DIR), "utf8"));
	} catch (error) {
		if (isErrnoException(error)) return { kind: "invalid", error: `Guard profile ${id} could not be read: ${error.message}` };
		throw error;
	}
}
