import { describe, expect, it } from "vitest";
import { parseAccessRules } from "../../lib/active-tools.js";
import {
  buildDelegationBlockedMessage,
  getPermittedDelegationTypes,
  hasDelegationPolicy,
  resolveDelegationPolicy,
  resolveDelegationRequest,
  resolveNestedTargets,
  resolvePersistedDelegationPolicy,
} from "../src/delegation-policy.js";
import type { AgentConfig } from "../src/types.js";

describe("delegation-policy", () => {
	const availableTypes = [
		"chengfeng",
		"wenchang",
		"jintong",
		"yunu",
		"guangguang",
		"taishang",
	];

	it("uses canonical type names and drops unknown names", () => {
		expect(
			getPermittedDelegationTypes(
				{
					rules: [{ sign: "+", selector: "ChengFeng" }, { sign: "+", selector: "TAISHANG" }, { sign: "+", selector: "missing" }],
				},
				availableTypes,
			),
		).toEqual(["chengfeng", "taishang"]);
	});

	it("subtracts names from previous grants", () => {
		expect(
			getPermittedDelegationTypes(
				{
					rules: [{ sign: "+", selector: "chengfeng" }, { sign: "+", selector: "wenchang" }, { sign: "+", selector: "taishang" }, { sign: "-", selector: "wenchang" }],
				},
				availableTypes,
			),
		).toEqual(["chengfeng", "taishang"]);
	});

	it("subtracts names after an explicit +@all grant", () => {
		expect(
			getPermittedDelegationTypes(
				{
					rules: [{ sign: "+", selector: "@all" }, { sign: "-", selector: "jintong" }, { sign: "-", selector: "yunu" }],
				},
				availableTypes,
			),
		).toEqual(["chengfeng", "wenchang", "guangguang", "taishang"]);
	});

	it("checks requested types case-insensitively", () => {
		expect(
			resolveDelegationRequest(
				{
					rules: [{ sign: "+", selector: "chengfeng" }, { sign: "+", selector: "taishang" }],
				},
				"TAISHANG",
				availableTypes,
			),
		).toEqual({
			allowed: true,
			requestedType: "taishang",
			permittedTypes: ["chengfeng", "taishang"],
		});
	});

	it("detects when a policy is absent", () => {
		expect(hasDelegationPolicy({ rules: [] })).toBe(false);
		expect(hasDelegationPolicy({ rules: [{ sign: "+", selector: "chengfeng" }] })).toBe(
			true,
		);
	});

	it("uses policy from the latest agent-mode session entry", () => {
		expect(
			resolvePersistedDelegationPolicy({
				entries: [
					{ type: "custom", customType: "agent-mode", data: { mode: "kuafu", delegationPolicy: { version: 2, rules: [{ sign: "+", selector: "chengfeng" }] } } },
					{ type: "custom", customType: "agent-mode", data: { mode: "fuxi", delegationPolicy: { version: 2, rules: [{ sign: "+", selector: "jintong" }] } } },
				],
				availableTypes,
				requestedType: "jintong",
			}),
		).toMatchObject({
			status: "resolved",
			activeMode: "fuxi",
			permittedTypes: ["jintong"],
			decision: { allowed: true },
		});
	});

	it("keeps sessions without an agent-mode entry unrestricted", () => {
		expect(resolvePersistedDelegationPolicy({
			entries: [{ type: "custom", customType: "other", data: {} }],
			availableTypes,
			requestedType: "jintong",
		})).toMatchObject({ status: "unrestricted", decision: { allowed: true } });
	});

	it.each([
		["missing policy", { mode: "fuxi" }],
		["v1 policy", { mode: "fuxi", delegationPolicy: { version: 1, allowDelegationTo: ["jintong"], disallowDelegationTo: [] } }],
		["unknown version", { mode: "fuxi", delegationPolicy: { version: 3, rules: [] } }],
		["malformed rules", { mode: "fuxi", delegationPolicy: { version: 2, rules: "+jintong" } }],
		["malformed rule member", { mode: "fuxi", delegationPolicy: { version: 2, rules: [1] } }],
		["unsigned rule", { mode: "fuxi", delegationPolicy: { version: 2, rules: [{ sign: "", selector: "jintong" }] } }],
		["invalid selector", { mode: "fuxi", delegationPolicy: { version: 2, rules: [{ sign: "+", selector: "@builtin" }] } }],
		["missing mode", { delegationPolicy: { version: 2, rules: [{ sign: "+", selector: "jintong" }] } }],
	])("fails closed for latest entry with %s", (_label, data) => {
		expect(resolvePersistedDelegationPolicy({
			entries: [
				{ type: "custom", customType: "agent-mode", data: { mode: "kuafu", delegationPolicy: { version: 2, rules: [{ sign: "+", selector: "jintong" }] } } },
				{ type: "custom", customType: "agent-mode", data },
			],
			availableTypes,
			requestedType: "jintong",
		})).toMatchObject({ status: "unresolved", permittedTypes: [], decision: { allowed: false, category: "delegation_policy_denied" } });
	});

	it("keeps no active mode unrestricted", () => {
		expect(resolveDelegationPolicy({ activeMode: undefined, availableTypes, requestedType: "jintong" })).toEqual({
			status: "unrestricted",
			activeMode: undefined,
			permittedTypes: availableTypes,
			decision: { allowed: true, category: undefined, requestedType: "jintong" },
		});
	});

	it("fails closed when an active mode config has no delegation policy", () => {
		expect(resolveDelegationPolicy({ activeMode: "fuxi", policy: { rules: [] }, availableTypes, requestedType: "jintong" })).toEqual({
			status: "unresolved",
			activeMode: "fuxi",
			permittedTypes: [],
			decision: { allowed: false, category: "delegation_policy_denied", requestedType: "jintong" },
		});
	});

	it("fails closed when an identified active mode config is unavailable", () => {
		expect(resolveDelegationPolicy({ activeMode: "missing", policy: undefined, availableTypes, requestedType: "jintong" })).toEqual({
			status: "unresolved",
			activeMode: "missing",
			permittedTypes: [],
			decision: { allowed: false, category: "delegation_policy_denied", requestedType: "jintong" },
		});
	});

  it("folds repeated rules left-to-right, deduplicating canonical names", () => {
    expect(getPermittedDelegationTypes({ rules: parseAccessRules("delegation", "+@all, -alpha, +ALPHA, +alpha").rules }, ["Alpha", "Beta"])).toEqual(["Beta", "Alpha"]);
  });

  it("treats only-minus rules as no policy", () => {
    const policy = { rules: parseAccessRules("delegation", "-jintong").rules };
    expect(hasDelegationPolicy(policy)).toBe(false);
    expect(resolveDelegationPolicy({ activeMode: "fuxi", policy, availableTypes, requestedType: "jintong" })).toMatchObject({ status: "unresolved", permittedTypes: [], decision: { allowed: false } });
  });

  it("uses one resolved policy decision with deterministic permitted ordering", () => {
    expect(resolveDelegationPolicy({
      activeMode: "fuxi",
      policy: { rules: [{ sign: "+", selector: "taishang" }, { sign: "+", selector: "chengfeng" }, { sign: "+", selector: "missing" }, { sign: "-", selector: "taishang" }] },
      availableTypes,
      requestedType: "chengfeng",
    })).toEqual({
      status: "resolved",
      activeMode: "fuxi",
      permittedTypes: ["chengfeng"],
      decision: { allowed: true, category: undefined, requestedType: "chengfeng" },
    });
  });

	it("formats a blocked delegation message with fallback info", () => {
		expect(
			buildDelegationBlockedMessage(
				"fuxi",
				"unknown-agent",
				"general-purpose",
				["chengfeng", "wenchang"],
			),
		).toContain('"unknown-agent" (resolved to "general-purpose")');
	});
});

describe("resolveNestedTargets", () => {
  const agent = (name: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
    name,
    description: name,
    extensionRules: [],
    toolRules: parseAccessRules("tools", "+read").rules,
    discoverSkills: false,
    preloadSkills: [],
    systemPrompt: "",
    promptMode: "replace",
    ...overrides,
  });
  const parent = agent("parent", { allowNesting: true, delegationRules: [{ sign: "+", selector: "leaf" }] });
  const guarded = (type: string) => type === "leaf";
  const targetsWith = (leaf: Partial<AgentConfig>, policy: Partial<AgentConfig> = {}) =>
    resolveNestedTargets({ ...parent, ...policy }, [parent, agent("leaf", leaf), agent("other")], guarded);

  it("permits an allowlisted read-only leaf", () => {
    expect(targetsWith({})).toEqual(["leaf"]);
  });

  it("permits guarded read-only Bash", () => {
    expect(targetsWith({ toolRules: parseAccessRules("tools", "+read, +bash").rules })).toEqual(["leaf"]);
  });

  it.each<[string, Partial<AgentConfig>, Partial<AgentConfig>]>([
    ["parent without derived nesting permission", {}, { allowNesting: false }],
    ["empty rules", {}, { delegationRules: [] }],
    ["subtracted target", {}, { delegationRules: [{ sign: "+", selector: "leaf" }, { sign: "-", selector: "leaf" }] }],
    ["disabled target", { enabled: false }, {}],
    ["nesting target", { allowNesting: true }, {}],
    ["append-mode target", { promptMode: "append" }, {}],
    ["edit grant", { toolRules: parseAccessRules("tools", "+read, +edit").rules }, {}],
    ["write grant", { toolRules: parseAccessRules("tools", "+@builtin, -edit").rules }, {}],
  ])("denies a %s", (_label, leaf, policy) => {
    expect(targetsWith(leaf, policy)).toEqual([]);
  });

  it("denies a target outside the allowlist", () => {
    expect(targetsWith({}, { delegationRules: [{ sign: "+", selector: "other" }] })).toEqual(["other"]);
  });

  it("denies unguarded Bash", () => {
    const configs = [parent, agent("leaf"), agent("shell", { toolRules: parseAccessRules("tools", "+read, +bash").rules })];
    expect(resolveNestedTargets({ ...parent, delegationRules: [{ sign: "+", selector: "leaf" }, { sign: "+", selector: "shell" }] }, configs, guarded)).toEqual(["leaf"]);
  });

  it("denies the parent's own type", () => {
    expect(resolveNestedTargets({ ...parent, delegationRules: [{ sign: "+", selector: "parent" }, { sign: "+", selector: "leaf" }] }, [parent, agent("leaf")], guarded)).toEqual(["leaf"]);
  });

  it("denies an unknown target", () => {
    expect(resolveNestedTargets({ ...parent, delegationRules: [{ sign: "+", selector: "missing" }] }, [parent, agent("leaf")], guarded)).toEqual([]);
  });
});
