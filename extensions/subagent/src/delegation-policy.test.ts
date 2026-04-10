import { describe, expect, it } from "vitest";
import {
	buildDelegationBlockedMessage,
	getCurrentDelegatorType,
	getPermittedDelegationTypes,
	hasDelegationPolicy,
	resolveDelegationRequest,
} from "./delegation-policy.js";

describe("delegation-policy", () => {
	const availableTypes = [
		"chengfeng",
		"wenchang",
		"jintong",
		"nuwa",
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
					disallowDelegationTo: ["jintong", "NUWA"],
				},
				availableTypes,
			),
		).toEqual(["chengfeng", "wenchang", "taishang"]);
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

	it("reads the latest agent-mode session entry", () => {
		expect(
			getCurrentDelegatorType([
				{ type: "custom", customType: "agent-mode", data: { mode: "kuafu" } },
				{ type: "custom", customType: "agent-mode", data: { mode: "fuxi" } },
			]),
		).toBe("fuxi");
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
