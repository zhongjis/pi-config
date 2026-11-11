import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GUARD_PROFILE_IDS } from "../../lib/guard-registration.js";
import { evaluateBashPolicy } from "../src/bash-policy.js";
import { loadGuardProfile, parseGuardProfile } from "../src/profile.js";

const VALID = `
allow: [read]
unmatched: classifier
classifier:
  instructions: Allow reads only.
  choices:
    allow: ok
    criteria: {ok: Reads only., bad: Anything else.}
rules:
  - {effect: wipe, on: segment, argv: [[rm, shred]]}
  - {effect: wipe, on: segment, argv: [touchy]}
  - {effect: read, on: stage, argv: [touchy]}
  - {effect: read, on: text, text: pwd}
`;

describe("guard profiles", () => {
	it("lists one loadable profile per profile file", () => {
		const files = readdirSync(new URL("../profiles/", import.meta.url)).filter((name) => name.endsWith(".yaml"));

		expect(GUARD_PROFILE_IDS).toEqual(files.map((name) => name.replace(/\.yaml$/, "")).sort());
		expect(GUARD_PROFILE_IDS.filter((id) => loadGuardProfile(id).kind !== "loaded")).toEqual([]);
	});

	it.each([
		["pwd", { kind: "allow" }],
		["rm out", { kind: "block", findings: [{ code: "wipe", position: 0 }] }],
		["touchy", { kind: "block", findings: [{ code: "wipe", position: 0 }] }],
		["ls", { kind: "defer" }],
	])("applies the profile's own rules to %j", (command, expected) => {
		const loaded = parseGuardProfile("synthetic", VALID);
		if (loaded.kind !== "loaded") throw new Error(loaded.error);

		expect(evaluateBashPolicy(loaded.profile, { command, effectiveCwd: "/repo" })).toEqual(expected);
	});

	it.each([
		["unknown top-level key", VALID.replace("unmatched:", "extra: 1\nunmatched:")],
		["unknown rule key", VALID.replace("text: pwd}", "text: pwd, extra: 1}")],
		["key outside the rule view", VALID.replace("argv: [touchy]}\n  - {effect: read", "argv: [touchy], flags: [-x]}\n  - {effect: read")],
		["wrong type", VALID.replace("allow: [read]", "allow: read")],
		["unknown view", VALID.replace("on: text", "on: anywhere")],
		["denial of an allowed effect", VALID.replace("effect: wipe, on: segment, argv: [touchy]", "effect: read, on: segment, argv: [touchy]")],
		["approval of a denied effect", VALID.replace("effect: read, on: text", "effect: wipe, on: text")],
		["invalid pattern", VALID.replace("argv: [touchy]}\n  - {effect: read, on: text", "argv: [touchy, {pattern: '['}]}\n  - {effect: read, on: text")],
		["undeclared required option", VALID.replace("on: stage, argv: [touchy]", "on: stage, argv: [touchy], require: [-x]")],
		["duplicate key", VALID.replace("unmatched: classifier", "unmatched: classifier\nunmatched: classifier")],
		["unsupported unmatched mode", VALID.replace("unmatched: classifier", "unmatched: allow")],
		["missing classifier", VALID.replace(/classifier:\n[\s\S]*?rules:/, "rules:")],
		["allow label outside criteria", VALID.replace("allow: ok", "allow: missing")],
		["malformed YAML", `${VALID}\n  - {effect: read`],
	])("fails closed on %s", (_name, source) => {
		expect(parseGuardProfile("synthetic", source)).toMatchObject({ kind: "invalid" });
	});

	it("fails closed when no profile file exists", () => {
		expect(loadGuardProfile("missing-profile")).toMatchObject({ kind: "invalid" });
	});
});
