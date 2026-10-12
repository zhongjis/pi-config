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

	it("uses canonical type names for allowlists", () => {
		expect(
			getPermittedDelegationTypes(
				{
					allowDelegationTo: ["ChengFeng", "TAISHANG", "missing"],
				},
				availableTypes,
			),
		).toEqual(["chengfeng", "taishang"]);
	});

	it("applies disallow list after allow list", () => {
		expect(
			getPermittedDelegationTypes(
				{
					allowDelegationTo: ["chengfeng", "wenchang", "taishang"],
					disallowDelegationTo: ["WENCHANG"],
				},
				availableTypes,
			),
		).toEqual(["chengfeng", "taishang"]);
	});

	it("subtracts denylist from all available types when no allowlist is set", () => {
		expect(
			getPermittedDelegationTypes(
				{
					disallowDelegationTo: ["jintong", "YUNU"],
				},
				availableTypes,
			),
		).toEqual(["chengfeng", "wenchang", "guangguang", "taishang"]);
	});

	it("checks requested types case-insensitively", () => {
		expect(
			resolveDelegationRequest(
				{
					allowDelegationTo: ["chengfeng", "taishang"],
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
		expect(hasDelegationPolicy({})).toBe(false);
		expect(hasDelegationPolicy({ allowDelegationTo: ["chengfeng"] })).toBe(
			true,
		);
	});

	it("uses policy from the latest agent-mode session entry", () => {
		expect(
			resolvePersistedDelegationPolicy({
				entries: [
					{ type: "custom", customType: "agent-mode", data: { mode: "kuafu", delegationPolicy: { version: 1, allowDelegationTo: ["chengfeng"], disallowDelegationTo: [] } } },
					{ type: "custom", customType: "agent-mode", data: { mode: "fuxi", delegationPolicy: { version: 1, allowDelegationTo: ["jintong"], disallowDelegationTo: [] } } },
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
		["unknown version", { mode: "fuxi", delegationPolicy: { version: 2, allowDelegationTo: ["jintong"], disallowDelegationTo: [] } }],
		["malformed allowlist", { mode: "fuxi", delegationPolicy: { version: 1, allowDelegationTo: "jintong", disallowDelegationTo: [] } }],
		["malformed denylist member", { mode: "fuxi", delegationPolicy: { version: 1, allowDelegationTo: ["jintong"], disallowDelegationTo: [1] } }],
		["missing mode", { delegationPolicy: { version: 1, allowDelegationTo: ["jintong"], disallowDelegationTo: [] } }],
	])("fails closed for latest entry with %s", (_label, data) => {
		expect(resolvePersistedDelegationPolicy({
			entries: [
				{ type: "custom", customType: "agent-mode", data: { mode: "kuafu", delegationPolicy: { version: 1, allowDelegationTo: ["jintong"], disallowDelegationTo: [] } } },
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
		expect(resolveDelegationPolicy({ activeMode: "fuxi", policy: {}, availableTypes, requestedType: "jintong" })).toEqual({
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

  it("uses one resolved policy decision with deterministic permitted ordering", () => {
    expect(resolveDelegationPolicy({
      activeMode: "fuxi",
      policy: { allowDelegationTo: ["TAISHANG", "chengfeng", "missing"], disallowDelegationTo: ["taishang"] },
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
  const parent = agent("parent", { allowNesting: true, allowDelegationTo: ["leaf"] });
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
    ["parent without allow_nesting", {}, { allowNesting: false }],
    ["missing allowlist", {}, { allowDelegationTo: undefined }],
    ["empty allowlist", {}, { allowDelegationTo: [] }],
    ["denylisted target", {}, { disallowDelegationTo: ["LEAF"] }],
    ["disabled target", { enabled: false }, {}],
    ["nesting target", { allowNesting: true }, {}],
    ["append-mode target", { promptMode: "append" }, {}],
    ["edit grant", { toolRules: parseAccessRules("tools", "+read, +edit").rules }, {}],
    ["write grant", { toolRules: parseAccessRules("tools", "+@builtin, -edit").rules }, {}],
  ])("denies a %s", (_label, leaf, policy) => {
    expect(targetsWith(leaf, policy)).toEqual([]);
  });

  it("denies a target outside the allowlist", () => {
    expect(targetsWith({}, { allowDelegationTo: ["other"] })).toEqual(["other"]);
  });

  it("denies unguarded Bash", () => {
    const configs = [parent, agent("leaf"), agent("shell", { toolRules: parseAccessRules("tools", "+read, +bash").rules })];
    expect(resolveNestedTargets({ ...parent, allowDelegationTo: ["leaf", "shell"] }, configs, guarded)).toEqual(["leaf"]);
  });

  it("denies the parent's own type", () => {
    expect(resolveNestedTargets({ ...parent, allowDelegationTo: ["PARENT", "leaf"] }, [parent, agent("leaf")], guarded)).toEqual(["leaf"]);
  });

  it("denies an unknown target", () => {
    expect(resolveNestedTargets({ ...parent, allowDelegationTo: ["missing"] }, [parent, agent("leaf")], guarded)).toEqual([]);
  });
});
