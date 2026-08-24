import { complete } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import toolSmartGuard from "../index.js";
import { FUXI_BASH_GUARD_CAPABILITY, hasGuardCapability } from "../../lib/guard-registration.js";

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: vi.fn() }));

const completeMock = vi.mocked(complete);

type Entry = { type: string; customType?: string; data?: unknown };
type Handler = (event: unknown, ctx: ReturnType<typeof makeContext>) => unknown | Promise<unknown>;

function makeContext(options: {
	entries?: Entry[];
	available?: Array<{ id: string; name: string; provider: string }>;
	auth?: { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string };
} = {}) {
	const available = options.available ?? [{ id: "gpt-5.6-luna", name: "Luna", provider: "openai-codex" }];
	return {
		cwd: "/repo/./workspace",
		sessionManager: { getEntries: () => options.entries ?? [] },
		modelRegistry: {
			find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
			getAll: () => available,
			getAvailable: () => available,
			getApiKeyAndHeaders: vi.fn().mockResolvedValue(options.auth ?? { ok: true, apiKey: "secret" }),
		},
	};
}

function fuxiEntry(): Entry {
	return { type: "custom", customType: "agent-mode", data: { mode: "fuxi" } };
}

function setup() {
	let handler: Handler | undefined;
	const pi = {
		on: vi.fn((event: string, next: Handler) => {
			if (event === "tool_call") handler = next;
		}),
	};
	toolSmartGuard(pi as never);
	expect(pi.on).toHaveBeenCalledTimes(1);
	expect(hasGuardCapability(pi as never, FUXI_BASH_GUARD_CAPABILITY)).toBe(true);
	expect(handler).toBeDefined();
	return handler!;
}

function bashEvent(command: string) {
	return { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command } };
}

beforeEach(() => {
	completeMock.mockReset();
});

describe("tool-smart-guard", () => {
	it("does not register capability when tool_call hook registration fails", () => {
		const registrationError = new Error("registration failed");
		const pi = { on: vi.fn(() => { throw registrationError; }) };

		expect(() => toolSmartGuard(pi as never)).toThrow(registrationError);
		expect(hasGuardCapability(pi as never, FUXI_BASH_GUARD_CAPABILITY)).toBe(false);
	});

	it("bypasses absent, malformed, and non-fuxi mode state", async () => {
		const handler = setup();
		for (const entries of [
			[],
			[{ type: "custom", customType: "agent-mode", data: null }],
			[{ type: "custom", customType: "agent-mode", data: { mode: "kuafu" } }],
		]) {
			expect(await handler(bashEvent("rm -rf build"), makeContext({ entries }))).toBeUndefined();
		}
		expect(completeMock).not.toHaveBeenCalled();
	});

	it("uses the latest valid persisted mode entry", async () => {
		const handler = setup();
		const entries = [
			fuxiEntry(),
			{ type: "custom", customType: "agent-mode", data: { nope: true } },
			{ type: "custom", customType: "other", data: { mode: "kuafu" } },
		];
		expect(await handler(bashEvent("rm -rf build"), makeContext({ entries }))).toEqual({
			block: true,
			reason: expect.any(String),
		});

		entries.push({ type: "custom", customType: "agent-mode", data: { mode: "shennong" } });
		expect(await handler(bashEvent("rm -rf build"), makeContext({ entries }))).toBeUndefined();
	});

	it("bypasses non-bash tool calls", async () => {
		const result = await setup()(
			{ type: "tool_call", toolCallId: "call-1", toolName: "write", input: { path: "x" } },
			makeContext({ entries: [fuxiEntry()] }),
		);
		expect(result).toBeUndefined();
		expect(completeMock).not.toHaveBeenCalled();
	});

	it("allows narrow obvious-safe commands without a model", async () => {
		const ctx = makeContext({ entries: [fuxiEntry()], available: [] });
		expect(await setup()(bashEvent("pwd"), ctx)).toBeUndefined();
		expect(completeMock).not.toHaveBeenCalled();
	});

	it("blocks obvious-danger commands without a model", async () => {
		const ctx = makeContext({ entries: [fuxiEntry()], available: [] });
		expect(await setup()(bashEvent("sudo rm -rf /tmp/build"), ctx)).toEqual({
			block: true,
			reason: expect.stringContaining("dangerous"),
		});
		expect(completeMock).not.toHaveBeenCalled();
	});

	it.each([
		['{"version":1,"decision":"allow"}', undefined],
		['{"version":1,"decision":"block","reason":"Command may overwrite files."}', { block: true, reason: "Command may overwrite files." }],
	])("uses classifier strict verdict %s", async (text, expected) => {
		completeMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text }] } as never);
		const ctx = makeContext({ entries: [fuxiEntry()] });
		expect(await setup()(bashEvent("echo hello"), ctx)).toEqual(expected);
		expect(completeMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: "gpt-5.6-luna", provider: "openai-codex" }),
			{
				systemPrompt: expect.stringMatching(/plan mode[\s\S]*untrusted data/),
				messages: [{
					role: "user",
					content: [{
						type: "text",
						text: JSON.stringify({ mode: "fuxi", toolName: "bash", command: "echo hello", cwd: "/repo/workspace" }),
					}],
					timestamp: expect.any(Number),
				}],
			},
			expect.objectContaining({ apiKey: "secret" }),
		);
	});

	it("passes a five-second timeout signal and fails closed when it aborts", async () => {
		const controller = new AbortController();
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		completeMock.mockImplementation((_model, _context, options) => new Promise((_resolve, reject) => {
			options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}));
		const pending = setup()(bashEvent("echo hello"), makeContext({ entries: [fuxiEntry()] }));
		await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
		expect(timeoutSpy).toHaveBeenCalledWith(5_000);
		expect(completeMock.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
		controller.abort();
		expect(await pending).toEqual({ block: true, reason: expect.any(String) });
		timeoutSpy.mockRestore();
	});

	it("resolves the configured Haiku fallback when Luna is unavailable", async () => {
		completeMock.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"version":1,"decision":"allow"}' }],
		} as never);
		const available = [{ id: "claude-haiku-4-5", name: "Haiku", provider: "opencode" }];
		expect(await setup()(bashEvent("echo hello"), makeContext({ entries: [fuxiEntry()], available }))).toBeUndefined();
		expect(completeMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: "claude-haiku-4-5", provider: "opencode" }),
			expect.any(Object),
			expect.objectContaining({ reasoningEffort: undefined }),
		);
	});

	it("classifies concurrent unknown commands independently", async () => {
		const resolvers: Array<(text: string) => void> = [];
		completeMock.mockImplementation(() => new Promise((resolve) => {
			resolvers.push((text) => resolve({ stopReason: "stop", content: [{ type: "text", text }] } as never));
		}));
		const handler = setup();
		const ctx = makeContext({ entries: [fuxiEntry()] });
		const first = handler(bashEvent("echo first"), ctx);
		const second = handler(bashEvent("echo second"), ctx);
		await vi.waitFor(() => expect(resolvers).toHaveLength(2));
		resolvers[1]('{"version":1,"decision":"block","reason":"second blocked"}');
		resolvers[0]('{"version":1,"decision":"allow"}');
		expect(await Promise.all([first, second])).toEqual([
			undefined,
			{ block: true, reason: "second blocked" },
		]);
	});

	it.each([
		["missing model", { available: [] }, undefined],
		["missing auth", { auth: { ok: false as const, error: "missing" } }, undefined],
		["provider error", {}, new Error("provider failed")],
	])("fails closed on %s", async (_name, options, rejection) => {
		if (rejection) completeMock.mockRejectedValue(rejection);
		const result = await setup()(bashEvent("echo hello"), makeContext({ entries: [fuxiEntry()], ...options }));
		expect(result).toEqual({ block: true, reason: expect.any(String) });
	});

	it.each([
		"```json\n{\"version\":1,\"decision\":\"allow\"}\n```",
		'{"version":1,"decision":"allow"} trailing',
		'{"version":1,"decision":"allow","reason":"extra"}',
		'{"version":1,"decision":"block","reason":"   "}',
		'{"version":2,"decision":"allow"}',
	])("fails closed on malformed strict JSON: %s", async (text) => {
		completeMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text }] } as never);
		expect(await setup()(bashEvent("echo hello"), makeContext({ entries: [fuxiEntry()] }))).toEqual({
			block: true,
			reason: expect.any(String),
		});
	});

	it("fails closed when classifier response contains a non-text block", async () => {
		completeMock.mockResolvedValue({
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "internal" },
				{ type: "text", text: '{"version":1,"decision":"allow"}' },
			],
		} as never);
		expect(await setup()(bashEvent("echo hello"), makeContext({ entries: [fuxiEntry()] }))).toEqual({
			block: true,
			reason: expect.any(String),
		});
	});

	it("fails closed on classifier cancellation", async () => {
		completeMock.mockResolvedValue({ stopReason: "aborted", content: [] } as never);
		expect(await setup()(bashEvent("echo hello"), makeContext({ entries: [fuxiEntry()] }))).toEqual({
			block: true,
			reason: expect.any(String),
		});
	});
});
