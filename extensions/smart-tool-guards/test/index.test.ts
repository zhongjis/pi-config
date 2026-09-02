import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	hasGuardCapability,
	registerGuardScopeProvider,
	SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY,
} from "../../lib/guard-registration.js";
import smartToolGuards from "../index.js";
import { classify } from "../src/classifier.js";

vi.mock("../src/classifier.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/classifier.js")>();
	return { ...original, classify: vi.fn() };
});

const classifyMock = vi.mocked(classify);
type Handler = (event: ToolCallEvent, ctx: ExtensionContext) => unknown | Promise<unknown>;

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

function makeRuntime(bus = eventBus()) {
	const handlers: Handler[] = [];
	const shutdownHandlers: ShutdownHandler[] = [];
	const pi = {
		events: bus.facade(),
		on: vi.fn((name: string, handler: Handler | ShutdownHandler) => {
			if (name === "tool_call") handlers.push(handler as Handler);
			if (name === "session_shutdown") shutdownHandlers.push(handler as ShutdownHandler);
		}),
	} as unknown as ExtensionAPI;
	return { pi, handlers, shutdownHandlers };
}

function context(cwd = "/repo/worktree"): ExtensionContext {
	return { cwd, modelRegistry: {} } as unknown as ExtensionContext;
}

function bashEvent(input: Record<string, unknown>): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "bash",
		input,
	} as ToolCallEvent;
}

function guard(pi: ExtensionAPI, id = "scope", reason = "Guard reason."): void {
	registerGuardScopeProvider(pi, id, () => ({ decision: "guard", reason }));
}

beforeEach(() => {
	classifyMock.mockReset();
	classifyMock.mockResolvedValue({ kind: "allow" });
});

describe("smart-tool-guards bash hook", () => {
	it("installs the hook before publishing capability", () => {
		const registrationError = new Error("registration failed");
		const bus = eventBus();
		const observer = makeRuntime(bus).pi;
		const pi = { events: bus.facade(), on: vi.fn(() => { throw registrationError; }) } as unknown as ExtensionAPI;

		expect(() => smartToolGuards(pi)).toThrow(registrationError);
		expect(hasGuardCapability(observer, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(false);
	});

	it("bypasses non-bash calls and all-abstain scope", async () => {
		const { pi, handlers } = makeRuntime();
		smartToolGuards(pi);
		expect(await handlers[0]({ type: "tool_call", toolCallId: "x", toolName: "write", input: {} } as ToolCallEvent, context())).toBeUndefined();
		expect(await handlers[0](bashEvent({ command: "rm -rf out" }), context())).toBeUndefined();
		expect(classifyMock).not.toHaveBeenCalled();
	});

	it("formats scope-provider errors before input or policy evaluation", async () => {
		const { pi, handlers } = makeRuntime();
		guard(pi, "active", " Active\nreason. ");
		registerGuardScopeProvider(pi, "broken", () => { throw new Error("secret"); });
		smartToolGuards(pi);

		expect(await handlers[0](bashEvent({ command: "pwd" }), context())).toEqual({
			block: true,
			reason: [
				"[Smart Guard][ERROR][source=scope][profile=bash-read-only-v1][scope=active,broken]",
				"Bash not run: Scope evaluation failed for providers: broken; guard failed closed. Guard active: Active reason.",
			].join("\n"),
		});
		expect(classifyMock).not.toHaveBeenCalled();
	});

	it("omits Guard active when scope failure has no successful active scope", async () => {
		const { pi, handlers } = makeRuntime();
		registerGuardScopeProvider(pi, "broken", () => { throw new Error("secret"); });
		smartToolGuards(pi);

		expect(await handlers[0](bashEvent({ command: "pwd" }), context())).toEqual({
			block: true,
			reason: [
				"[Smart Guard][ERROR][source=scope][profile=bash-read-only-v1][scope=broken]",
				"Bash not run: Scope evaluation failed for providers: broken; guard failed closed.",
			].join("\n"),
		});
	});

	it.each([
		{},
		{ command: 1 },
		{ command: "pwd", cwd: 1 },
		{ command: "pwd", timeout: "1" },
		{ command: "pwd", timeout: Number.NaN },
		{ command: "pwd", timeout: Number.POSITIVE_INFINITY },
		{ command: "pwd", timeout: -1 },
	])("blocks malformed guarded bash input: %j", async (input) => {
		const { pi, handlers } = makeRuntime();
		guard(pi);
		smartToolGuards(pi);
		expect(await handlers[0](bashEvent(input), context())).toEqual({
			block: true,
			reason: [
				"[Smart Guard][ERROR][source=input][profile=bash-read-only-v1][scope=scope]",
				"Bash not run: Malformed tool input. Guard active: Guard reason.",
			].join("\n"),
		});
		expect(classifyMock).not.toHaveBeenCalled();
	});

	it("allows exact trimmed pwd without classifier and preserves input identity/content", async () => {
		const bus = eventBus();
		const providerRuntime = makeRuntime(bus);
		const guardRuntime = makeRuntime(bus);
		guard(providerRuntime.pi);
		smartToolGuards(guardRuntime.pi);
		classifyMock.mockResolvedValue({ kind: "unavailable", reason: "Classifier unavailable." });
		const input = Object.freeze({ command: " \tpwd\n ", cwd: "packages/app", timeout: 0 });
		const event = bashEvent(input);

		expect(await guardRuntime.handlers[0](event, context())).toBeUndefined();
		expect(event.input).toBe(input);
		expect(event.input).toEqual({ command: " \tpwd\n ", cwd: "packages/app", timeout: 0 });
		expect(classifyMock).not.toHaveBeenCalled();
	});

	it("formats deterministic policy findings with sorted scopes and no dangerous wording", async () => {
		const { pi, handlers } = makeRuntime();
		guard(pi, "z-scope", " Second\nactivation. ");
		guard(pi, "a-scope", "First activation.");
		smartToolGuards(pi);
		classifyMock.mockResolvedValue({ kind: "allow" });

		const result = await handlers[0](bashEvent({ command: "rm out; git push" }), context());
		expect(result).toEqual({
			block: true,
			reason: [
				"[Smart Guard][BLOCK][source=policy][profile=bash-read-only-v1][scope=a-scope,z-scope]",
				"Bash not run: Read-only policy matched: filesystem-mutation, vcs-mutation. Guard active: First activation. Second activation.",
			].join("\n"),
		});
		expect((result as { reason: string }).reason).not.toMatch(/dangerous/i);
		expect(classifyMock).not.toHaveBeenCalled();
	});

	it("classifies deferred commands with exact requested values and resolved cwd", async () => {
		const { pi, handlers } = makeRuntime();
		guard(pi);
		smartToolGuards(pi);
		const input = Object.freeze({ command: "git status", cwd: "packages/../app", timeout: 12.5 });

		expect(await handlers[0](bashEvent(input), context("/repo/worktree"))).toBeUndefined();
		expect(classifyMock).toHaveBeenCalledWith({
			policyId: "bash-read-only-v1",
			policyInstructions: [
				"Allow only bash actions that are read-only.",
				"The guarded bash tool is the evaluation context; using it does not itself count as shell execution.",
				"Block actions that may mutate local, version-control, service, or external-system state.",
				"Block commands that invoke a shell or language interpreter as an executable, or that execute downloaded or generated code.",
				"Allow fixed text written only to stdout, such as `printf classifier-ok`, when no other side effect is present.",
				"When uncertain whether the exact action is read-only, block.",
			].join("\n"),
			target: "bash",
			action: {
				command: "git status",
				requestedCwd: "packages/../app",
				requestedTimeout: 12.5,
			},
			context: { effectiveCwd: resolve("/repo/worktree", "packages/../app") },
		}, expect.objectContaining({ cwd: "/repo/worktree" }));
	});

	it("formats classifier blocks and unavailable errors without leaking provider details", async () => {
		const { pi, handlers } = makeRuntime();
		guard(pi);
		smartToolGuards(pi);
		classifyMock.mockResolvedValueOnce({ kind: "block", reason: " Not\n read-only. " });
		expect(await handlers[0](bashEvent({ command: "git status" }), context())).toEqual({
			block: true,
			reason: [
				"[Smart Guard][BLOCK][source=classifier][profile=bash-read-only-v1][scope=scope]",
				"Bash not run: Not read-only. Guard active: Guard reason.",
			].join("\n"),
		});
		classifyMock.mockResolvedValueOnce({ kind: "unavailable", reason: "secret\nprovider failure" });
		expect(await handlers[0](bashEvent({ command: "git status" }), context())).toEqual({
			block: true,
			reason: [
				"[Smart Guard][ERROR][source=classifier][profile=bash-read-only-v1][scope=scope]",
				"Bash not run: Classifier unavailable; guard failed closed. Guard active: Guard reason.",
			].join("\n"),
		});
	});

	it.each([
		["classifier blocked", "classifier blocked."],
		["Stop!", "Stop!"],
		["Unsafe?", "Unsafe?"],
	] as const)("terminates normalized classifier detail without replacing punctuation: %s", async (reason, expected) => {
		const { pi, handlers } = makeRuntime();
		guard(pi);
		smartToolGuards(pi);
		classifyMock.mockResolvedValue({ kind: "block", reason: ` \n${reason}\t ` });

		expect(await handlers[0](bashEvent({ command: "git status" }), context())).toEqual({
			block: true,
			reason: [
				"[Smart Guard][BLOCK][source=classifier][profile=bash-read-only-v1][scope=scope]",
				`Bash not run: ${expected} Guard active: Guard reason.`,
			].join("\n"),
		});
	});

	it.each([
		["mode first", ["mode", "subagent"]],
		["subagent first", ["subagent", "mode"]],
	] as const)("dedupes same-facade init and installs on a new facade: %s", async (_name, order) => {
		const bus = eventBus();
		const providerRuntime = makeRuntime(bus);
		const first = makeRuntime(bus);
		const second = makeRuntime(bus);
		const providers = {
			mode: () => "abstain" as const,
			subagent: () => ({ decision: "guard" as const, reason: "Guarded subagent." }),
		};
		for (const id of order) registerGuardScopeProvider(providerRuntime.pi, id, providers[id]);

		smartToolGuards(first.pi);
		smartToolGuards(first.pi);
		smartToolGuards(second.pi);
		expect(first.handlers).toHaveLength(1);
		expect(second.handlers).toHaveLength(1);
		expect(hasGuardCapability(makeRuntime(bus).pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(true);
		expect(await second.handlers[0](bashEvent({ command: "git status" }), context())).toBeUndefined();
		expect(classifyMock).toHaveBeenCalledOnce();
	});

	it("reinstalls one hook and capability after shutdown on retained bus", async () => {
		const bus = eventBus();
		const firstProvider = makeRuntime(bus);
		const first = makeRuntime(bus);
		guard(firstProvider.pi);
		smartToolGuards(first.pi);

		expect(first.handlers).toHaveLength(1);
		expect(hasGuardCapability(makeRuntime(bus).pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(true);
		for (const shutdown of [...firstProvider.shutdownHandlers, ...first.shutdownHandlers]) await shutdown();
		expect(hasGuardCapability(makeRuntime(bus).pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(false);

		const replacementProvider = makeRuntime(bus);
		const replacement = makeRuntime(bus);
		guard(replacementProvider.pi);
		smartToolGuards(replacement.pi);
		smartToolGuards(replacement.pi);

		expect(replacement.handlers).toHaveLength(1);
		expect(hasGuardCapability(makeRuntime(bus).pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY)).toBe(true);
		expect(await replacement.handlers[0](bashEvent({ command: "pwd" }), context())).toBeUndefined();
	});
});
