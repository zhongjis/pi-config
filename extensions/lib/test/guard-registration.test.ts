import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	evaluateGuardScope,
	hasGuardCapability,
	registerGuardCapability,
	registerGuardScopeProvider,
	SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY,
	type GuardCapability,
	type GuardScopeProvider,
} from "../guard-registration.js";

const event = {
	type: "tool_call",
	toolCallId: "call-1",
	toolName: "bash",
	input: { command: "pwd" },
} satisfies ToolCallEvent;
const ctx = { cwd: "/repo" } as unknown as ExtensionContext;

type ShutdownHandler = () => unknown | Promise<unknown>;
type BusHandler = (data: unknown) => void;

function eventBus() {
	const listeners = new Map<string, Set<BusHandler>>();
	return {
		facade() {
			return {
				emit: (channel: string, data: unknown) => {
					for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
				},
				on: (channel: string, handler: BusHandler) => {
					const channelListeners = listeners.get(channel) ?? new Set<BusHandler>();
					channelListeners.add(handler);
					listeners.set(channel, channelListeners);
					return () => {
						channelListeners.delete(handler);
						if (channelListeners.size === 0) listeners.delete(channel);
					};
				},
			};
		},
	};
}

function runtime(bus = eventBus(), shutdownHandlers: ShutdownHandler[] = []) {
	return {
		events: bus.facade(),
		on: (name: string, handler: ShutdownHandler) => {
			if (name === "session_shutdown") shutdownHandlers.push(handler);
		},
	} as unknown as ExtensionAPI;
}

describe("guard capability registration", () => {
	it("shares capability across distinct facades on one synchronous bus and isolates separate buses", () => {
		const sharedBus = eventBus();
		const first = runtime(sharedBus);
		const second = runtime(sharedBus);
		const separate = runtime(eventBus());

		expect(first.events).not.toBe(second.events);
		expect(hasGuardCapability(first, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(false);
		registerGuardCapability(first, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY);
		expect(hasGuardCapability(second, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(true);
		expect(hasGuardCapability(separate, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(false);
	});

	it("revokes capability on shutdown and allows registration on retained bus", async () => {
		const bus = eventBus();
		const oldShutdownHandlers: ShutdownHandler[] = [];
		const oldRuntime = runtime(bus, oldShutdownHandlers);
		registerGuardCapability(oldRuntime, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY);

		expect(hasGuardCapability(runtime(bus), SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(true);
		expect(oldShutdownHandlers).toHaveLength(1);
		await oldShutdownHandlers[0]();
		expect(hasGuardCapability(runtime(bus), SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(false);

		const replacement = runtime(bus);
		registerGuardCapability(replacement, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY);
		expect(hasGuardCapability(runtime(bus), SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(true);
	});

	it("ignores legacy process-global capability and scope registries", async () => {
		const bus = eventBus();
		const shutdownHandlers: ShutdownHandler[] = [];
		const pi = runtime(bus, shutdownHandlers);
		const legacyCapabilities = new WeakMap<object, Set<GuardCapability>>();
		legacyCapabilities.set(pi.events, new Set([SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY]));
		Reflect.set(globalThis, Symbol.for("pi-config.guard-registration-registry"), legacyCapabilities);
		const legacyScopes = new WeakMap<object, Map<string, GuardScopeProvider>>();
		legacyScopes.set(pi.events, new Map([["legacy", () => "guard"]]));
		Reflect.set(globalThis, Symbol.for("pi-config.guard-scope-provider-registry"), legacyScopes);

		expect(hasGuardCapability(pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(false);
		expect(await evaluateGuardScope(pi, event, ctx)).toBe("abstain");
		expect(() => registerGuardCapability(pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).not.toThrow();
		expect(hasGuardCapability(runtime(bus), SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(true);
	});
});

describe("guard scope providers", () => {
	it.each([
		["mode first", ["modes:fuxi", "subagents:guarded"]],
		["subagent first", ["subagents:guarded", "modes:fuxi"]],
	] as const)("activates when any provider guards: %s", async (_name, ids) => {
		const bus = eventBus();
		const providerRuntime = runtime(bus);
		const evaluatorRuntime = runtime(bus);
		const providers = {
			"modes:fuxi": vi.fn<GuardScopeProvider>(() => "abstain"),
			"subagents:guarded": vi.fn<GuardScopeProvider>(() => "guard"),
		};
		for (const id of ids) registerGuardScopeProvider(providerRuntime, id, providers[id]);
		expect(providerRuntime.events).not.toBe(evaluatorRuntime.events);

		expect(await evaluateGuardScope(evaluatorRuntime, event, ctx)).toBe("guard");
		expect(providers["modes:fuxi"]).toHaveBeenCalledOnce();
		expect(providers["subagents:guarded"]).toHaveBeenCalledOnce();
	});

	it("bypasses when every provider abstains", async () => {
		const pi = runtime();
		registerGuardScopeProvider(pi, "modes:fuxi", () => "abstain");
		registerGuardScopeProvider(pi, "subagents:guarded", async (): Promise<"abstain"> => "abstain");

		expect(await evaluateGuardScope(pi, event, ctx)).toBe("abstain");
	});

	it("uses latest listener for a duplicate provider ID without removing others", async () => {
		const bus = eventBus();
		const replaced = vi.fn<GuardScopeProvider>(() => "guard");
		const replacement = vi.fn<GuardScopeProvider>(() => "abstain");
		const other = vi.fn<GuardScopeProvider>(() => "guard");
		registerGuardScopeProvider(runtime(bus), "modes:fuxi", replaced);
		registerGuardScopeProvider(runtime(bus), "subagents:guarded", other);
		registerGuardScopeProvider(runtime(bus), "modes:fuxi", replacement);

		expect(await evaluateGuardScope(runtime(bus), event, ctx)).toBe("guard");
		expect(replaced).not.toHaveBeenCalled();
		expect(replacement).toHaveBeenCalledOnce();
		expect(other).toHaveBeenCalledOnce();
	});

	it("removes a scope provider listener on shutdown", async () => {
		const bus = eventBus();
		const shutdownHandlers: ShutdownHandler[] = [];
		const pi = runtime(bus, shutdownHandlers);
		registerGuardScopeProvider(pi, "modes:fuxi", () => "guard");

		expect(await evaluateGuardScope(runtime(bus), event, ctx)).toBe("guard");
		expect(shutdownHandlers).toHaveLength(1);
		await shutdownHandlers[0]();
		expect(await evaluateGuardScope(runtime(bus), event, ctx)).toBe("abstain");
	});

	it("does not let stale provider cleanup remove its replacement", async () => {
		const bus = eventBus();
		const oldShutdownHandlers: ShutdownHandler[] = [];
		const replacementShutdownHandlers: ShutdownHandler[] = [];
		const replacement = vi.fn<GuardScopeProvider>(() => "guard");
		registerGuardScopeProvider(runtime(bus, oldShutdownHandlers), "modes:fuxi", () => "abstain");
		registerGuardScopeProvider(runtime(bus, replacementShutdownHandlers), "modes:fuxi", replacement);

		expect(oldShutdownHandlers).toHaveLength(1);
		await oldShutdownHandlers[0]();
		expect(await evaluateGuardScope(runtime(bus), event, ctx)).toBe("guard");
		expect(replacement).toHaveBeenCalledOnce();
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

	it("isolates providers across separate buses", async () => {
		const guardedBus = eventBus();
		const separateBus = eventBus();
		registerGuardScopeProvider(runtime(guardedBus), "modes:fuxi", () => "guard");

		expect(await evaluateGuardScope(runtime(guardedBus), event, ctx)).toBe("guard");
		expect(await evaluateGuardScope(runtime(separateBus), event, ctx)).toBe("abstain");
	});
});
