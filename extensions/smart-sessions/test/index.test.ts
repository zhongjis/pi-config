import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import sessionSummaryExtension from "../index.js";

type ModelEntry = { id: string; name?: string; provider: string };

const mockedResult = vi.fn(async () => ({
	stopReason: "stop" as const,
	usage: { input: 1, output: 1 },
	content: [{ type: "text" as const, text: "focused session summary" }],
}));
const mockedStreamSimple = vi.fn((_model: unknown, _context: unknown, _options?: Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[2]) => ({ result: mockedResult }));

let tempRoot = "";
let tempAgentDir = "";
let tempCwd = "";
let originalAgentDir: string | undefined;

beforeEach(async () => {
	tempRoot = join(tmpdir(), `smart-sessions-test-${process.pid}-${Date.now()}`);
	tempAgentDir = join(tempRoot, "agent");
	tempCwd = join(tempRoot, "repo");
	await mkdir(tempAgentDir, { recursive: true });
	await mkdir(tempCwd, { recursive: true });
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir;
	mockedStreamSimple.mockClear();
	mockedResult.mockClear();
	mockedResult.mockResolvedValue({
		stopReason: "stop",
		usage: { input: 1, output: 1 },
		content: [{ type: "text", text: "focused session summary" }],
	});
});

afterEach(async () => {
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	await rm(tempRoot, { force: true, recursive: true });
});

function createSummaryContext(models: ModelEntry[]) {
	const base = createMockContext();
	return {
		...base,
		cwd: tempCwd,
		sessionManager: {
			...base.sessionManager,
			getBranch: vi.fn(() => [
				{
					type: "message",
					message: { role: "user", content: "Please summarize this session." },
				},
			]),
		},
		modelRegistry: {
			...base.modelRegistry,
			find: vi.fn((provider: string, modelId: string) =>
				models.find((model) => model.provider === provider && model.id === modelId),
			),
			hasConfiguredAuth: vi.fn(() => true),
			streamSimple: mockedStreamSimple,
			getAvailable: vi.fn(() => models),
		},
		ui: { ...base.ui, setWidget: vi.fn() },
	};
}

function registerExtension(models: ModelEntry[]) {
	const mock = createMockPi();
	const ctx = createSummaryContext(models);
	sessionSummaryExtension(mock.pi as never);
	return { ctx, mock };
}

async function runSummary(models: ModelEntry[]) {
	const { ctx, mock } = registerExtension(models);

	await mock.fireLifecycle("session_start", {}, ctx);
	await mock.fireLifecycle("agent_end", {}, ctx);
	await Promise.resolve();

	return { ctx, mock };
}

describe("smart-sessions model selection", () => {
	it.each([["off", undefined], ["high", "high"]] as const)("uses provider-neutral reasoning for %s", async (thinking, expected) => {
		await writeFile(
			join(tempAgentDir, "tool_models.json"),
			JSON.stringify({ version: 1, roles: { "summary.session": `test/summary-model:${thinking}` } }),
		);
		await runSummary([{ id: "summary-model", provider: "test" }]);

		expect(mockedStreamSimple).toHaveBeenCalledWith(
			expect.objectContaining({ id: "summary-model", provider: "test" }),
			expect.any(Object),
			expect.objectContaining({ reasoning: expected }),
		);
		expect(mockedStreamSimple.mock.calls[0]?.[2]).not.toHaveProperty("reasoningEffort");
		expect(mockedResult).toHaveBeenCalledTimes(1);
	});

	it("sends the summary through modelRegistry.streamSimple without caller auth", async () => {
		const model = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" };
		const { ctx } = await runSummary([model]);
		expect(ctx.modelRegistry.streamSimple).toHaveBeenCalledWith(
			expect.objectContaining({ id: model.id, provider: model.provider }),
			expect.any(Object),
			expect.objectContaining({ maxTokens: 300, sessionId: "mock-session-id" }),
		);
		const options = ctx.modelRegistry.streamSimple.mock.calls[0]?.[2];
		expect(options).not.toHaveProperty("apiKey");
		expect(options).not.toHaveProperty("headers");
	});

	it("aborts the in-flight summary on session_shutdown", async () => {
		const model = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" };
		const { ctx, mock } = await runSummary([model]);
		const signal = ctx.modelRegistry.streamSimple.mock.calls[0]?.[2]?.signal;
		expect(signal?.aborted).toBe(false);
		await mock.fireLifecycle("session_shutdown", {}, ctx);
		expect(signal?.aborted).toBe(true);
	});

	it.each([
		["Anthropic Haiku", { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" }],
		["local Qwen", { id: "qwen2.5-coder:14b", name: "Qwen2.5 Coder 14B", provider: "llama-swap" }],
	])("auto-detects the %s summary model", async (_label, model) => {
		await runSummary([model]);

		expect(mockedStreamSimple).toHaveBeenCalledWith(
			expect.objectContaining({ id: model.id, provider: model.provider }),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("uses global tool_models.json when session-summary provider/model are blank", async () => {
		await writeFile(
			join(tempAgentDir, "session-summary.json"),
			JSON.stringify({ provider: "", model: "" }),
		);
		await writeFile(
			join(tempAgentDir, "tool_models.json"),
			JSON.stringify({
				version: 1,
				roles: { "summary.session": "gemini-3-flash:off" },
				tools: { "smart-sessions.summary": { role: "summary.session" } },
			}),
		);

		await runSummary([
			{ id: "gpt-5.4-mini", name: "GPT 5.4 Mini", provider: "openai" },
			{ id: "gemini-3-flash", name: "Gemini 3 Flash", provider: "google" },
		]);

		expect(mockedStreamSimple).toHaveBeenCalledWith(
			expect.objectContaining({ id: "gemini-3-flash", provider: "google" }),
			expect.any(Object),
			expect.objectContaining({ reasoning: undefined }),
		);
	});

	it("uses project tool_models.json over global when session-summary provider/model are blank", async () => {
		await writeFile(
			join(tempAgentDir, "session-summary.json"),
			JSON.stringify({ provider: "", model: "" }),
		);
		await writeFile(
			join(tempAgentDir, "tool_models.json"),
			JSON.stringify({ version: 1, roles: { "summary.session": "gpt-5.4-mini" } }),
		);
		await mkdir(join(tempCwd, ".pi"), { recursive: true });
		await writeFile(
			join(tempCwd, ".pi", "tool_models.json"),
			JSON.stringify({ version: 1, roles: { "summary.session": "claude-haiku-4-5" } }),
		);

		await runSummary([
			{ id: "gpt-5.4-mini", name: "GPT 5.4 Mini", provider: "openai" },
			{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
		]);

		expect(mockedStreamSimple).toHaveBeenCalledWith(
			expect.objectContaining({ id: "claude-haiku-4-5", provider: "anthropic" }),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("does not silently fall back when explicit config points at an unavailable model", async () => {
		await writeFile(
			join(tempAgentDir, "session-summary.json"),
			JSON.stringify({ provider: "anthropic", model: "missing-model", showWidget: true }),
		);
		const { ctx } = await runSummary([
			{ id: "qwen2.5-coder:14b", name: "Qwen2.5 Coder 14B", provider: "llama-swap" },
		]);

		expect(mockedStreamSimple).not.toHaveBeenCalled();
		expect(ctx.modelRegistry.find).toHaveBeenCalledWith("anthropic", "missing-model");
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(
			"session-summary",
			expect.arrayContaining([expect.stringContaining("MODEL_NOT_FOUND")]),
			expect.any(Object),
		);
	});

	it("falls back to ctx.model when the summary chain has no available model", async () => {
		// No available model matches the built-in summary.session chain, so the
		// configured chain resolves to nothing and the current session model
		// (ctx.model = mock-model) must be used instead of erroring out.
		await runSummary([
			{ id: "some-unrelated-model", name: "Unrelated", provider: "other" },
		]);

		expect(mockedStreamSimple).toHaveBeenCalledWith(
			expect.objectContaining({ id: "mock-model", provider: "mock" }),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("creates settings that preserve auto-detection by default", async () => {
		const { ctx, mock } = registerExtension([
			{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
		]);
		const command = mock.commands.get("summary:settings") as {
			handler: (args: unknown, ctx: unknown) => Promise<void>;
		};

		await command.handler([], ctx);

		const settings = JSON.parse(await readFile(join(tempAgentDir, "session-summary.json"), "utf8"));
		expect(settings.provider).toBe("");
		expect(settings.model).toBe("");
	});
});
