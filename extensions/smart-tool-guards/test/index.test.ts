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

function guard(pi: ExtensionAPI, id = "scope"): void {
	registerGuardScopeProvider(pi, id, () => "guard");
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

	it("blocks scope-provider errors before input or policy evaluation", async () => {
		const { pi, handlers } = makeRuntime();
		registerGuardScopeProvider(pi, "broken", () => { throw new Error("secret"); });
		smartToolGuards(pi);

		expect(await handlers[0](bashEvent({ command: "pwd" }), context())).toEqual({
			block: true,
			reason: "Blocked because guard scope provider evaluation failed: broken.",
		});
		expect(classifyMock).not.toHaveBeenCalled();
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
			reason: "Blocked because bash tool input is invalid.",
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

	it("blocks deterministic danger with stable codes before classifier", async () => {
		const { pi, handlers } = makeRuntime();
		guard(pi);
		smartToolGuards(pi);
		classifyMock.mockResolvedValue({ kind: "allow" });

		expect(await handlers[0](bashEvent({ command: "rm out; git push" }), context())).toEqual({
			block: true,
			reason: "Blocked dangerous bash command: filesystem-mutation, vcs-mutation",
		});
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

	it("propagates classifier block and fails closed on unavailable", async () => {
		const { pi, handlers } = makeRuntime();
		guard(pi);
		smartToolGuards(pi);
		classifyMock.mockResolvedValueOnce({ kind: "block", reason: "Not read-only." });
		expect(await handlers[0](bashEvent({ command: "git status" }), context())).toEqual({
			block: true,
			reason: "Not read-only.",
		});
		classifyMock.mockResolvedValueOnce({ kind: "unavailable", reason: "Classifier unavailable." });
		expect(await handlers[0](bashEvent({ command: "git status" }), context())).toEqual({
			block: true,
			reason: "Blocked because the bash safety classifier is unavailable.",
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
			subagent: () => "guard" as const,
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
