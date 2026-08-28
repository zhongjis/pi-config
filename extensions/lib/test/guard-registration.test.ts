import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	evaluateGuardScope,
	hasGuardCapability,
	registerGuardCapability,
	registerGuardScopeProvider,
	SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY,
	type GuardScopeProvider,
} from "../guard-registration.js";

const event = {
	type: "tool_call",
	toolCallId: "call-1",
	toolName: "bash",
	input: { command: "pwd" },
} satisfies ToolCallEvent;
const ctx = { cwd: "/repo" } as unknown as ExtensionContext;

function runtime(events?: object) {
	return (events ? { events } : {}) as ExtensionAPI;
}

describe("guard capability registration", () => {
	it("tracks capability presence by shared runtime key", () => {
		const sharedEvents = {};
		const first = runtime(sharedEvents);
		const second = runtime(sharedEvents);
		const separate = runtime();

		expect(hasGuardCapability(first, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(false);
		registerGuardCapability(first, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY);
		expect(hasGuardCapability(second, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(true);
		expect(hasGuardCapability(separate, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(false);
	});

	it("falls back to the ExtensionAPI object when events is unavailable", () => {
		const pi = runtime();
		const separate = runtime();
		expect("events" in pi).toBe(false);
		expect("events" in separate).toBe(false);

		registerGuardCapability(pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY);

		expect(hasGuardCapability(pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(true);
		expect(hasGuardCapability(separate, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(false);
	});
});

describe("guard scope providers", () => {
	it.each([
		["mode first", ["modes:fuxi", "subagents:guarded"]],
		["subagent first", ["subagents:guarded", "modes:fuxi"]],
	] as const)("activates when any provider guards: %s", async (_name, ids) => {
		const pi = runtime();
		const providers = {
			"modes:fuxi": vi.fn<GuardScopeProvider>(() => "abstain"),
			"subagents:guarded": vi.fn<GuardScopeProvider>(() => "guard"),
		};
		for (const id of ids) registerGuardScopeProvider(pi, id, providers[id]);

		expect(await evaluateGuardScope(pi, event, ctx)).toBe("guard");
		expect(providers["modes:fuxi"]).toHaveBeenCalledOnce();
		expect(providers["subagents:guarded"]).toHaveBeenCalledOnce();
	});

	it("bypasses when every provider abstains", async () => {
		const pi = runtime();
		registerGuardScopeProvider(pi, "modes:fuxi", () => "abstain");
		registerGuardScopeProvider(pi, "subagents:guarded", async (): Promise<"abstain"> => "abstain");

		expect(await evaluateGuardScope(pi, event, ctx)).toBe("abstain");
	});

	it("replaces one provider ID without removing other providers", async () => {
		const pi = runtime();
		const replaced = vi.fn<GuardScopeProvider>(() => "guard");
		const replacement = vi.fn<GuardScopeProvider>(() => "abstain");
		const other = vi.fn<GuardScopeProvider>(() => "guard");
		registerGuardScopeProvider(pi, "modes:fuxi", replaced);
		registerGuardScopeProvider(pi, "subagents:guarded", other);
		registerGuardScopeProvider(pi, "modes:fuxi", replacement);

		expect(await evaluateGuardScope(pi, event, ctx)).toBe("guard");
		expect(replaced).not.toHaveBeenCalled();
		expect(replacement).toHaveBeenCalledOnce();
		expect(other).toHaveBeenCalledOnce();
	});

	it.each([
		["throw", () => { throw new Error("provider failed"); }],
		["invalid return", () => "invalid" as never],
	] as const)("returns an explicit blocking scope error on provider %s", async (_name, failingProvider) => {
		const results = [];
		for (const ids of [["failing", "guarding"], ["guarding", "failing"]]) {
			const pi = runtime();
			const providers: Record<string, GuardScopeProvider> = {
				failing: failingProvider,
				guarding: () => "guard",
			};
			for (const id of ids) registerGuardScopeProvider(pi, id, providers[id]);
			results.push(await evaluateGuardScope(pi, event, ctx));
		}

		expect(results[0]).toEqual(results[1]);
		expect(results[0]).toEqual({
			block: true,
			reason: expect.stringMatching(/scope provider.*failing/i),
		});
	});

	it("isolates providers across runtime keys", async () => {
		const guarded = runtime();
		const unguarded = runtime();
		registerGuardScopeProvider(guarded, "modes:fuxi", () => "guard");

		expect(await evaluateGuardScope(guarded, event, ctx)).toBe("guard");
		expect(await evaluateGuardScope(unguarded, event, ctx)).toBe("abstain");
	});
});
