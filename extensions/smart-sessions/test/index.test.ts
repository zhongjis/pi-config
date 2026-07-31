import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "@earendil-works/pi-ai/compat";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import sessionSummaryExtension from "../index.js";

vi.mock("@earendil-works/pi-ai/compat", () => ({
	complete: vi.fn(async () => ({
		stopReason: "stop",
		usage: { input: 1, output: 1 },
		content: [{ type: "text", text: "focused session summary" }],
	})),
}));

type ModelEntry = { id: string; name?: string; provider: string };

const mockedComplete = vi.mocked(complete);

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
	mockedComplete.mockClear();
	mockedComplete.mockResolvedValue({
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
	const ctx = createMockContext() as ReturnType<typeof createMockContext> & {
		modelRegistry: {
			find: ReturnType<typeof vi.fn>;
			getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
			getAvailable: ReturnType<typeof vi.fn>;
		};
		sessionManager: ReturnType<typeof createMockContext>["sessionManager"] & {
			getBranch: ReturnType<typeof vi.fn>;
		};
		ui: ReturnType<typeof createMockContext>["ui"] & {
			setWidget: ReturnType<typeof vi.fn>;
		};
	};

	ctx.cwd = tempCwd;
	ctx.sessionManager = {
		...ctx.sessionManager,
		getBranch: vi.fn(() => [
			{
				type: "message",
				message: { role: "user", content: "Please summarize this session." },
			},
		]),
	};
	ctx.modelRegistry = {
		find: vi.fn((provider: string, modelId: string) =>
			models.find((model) => model.provider === provider && model.id === modelId),
		),
		getApiKeyAndHeaders: vi.fn(async () => ({ apiKey: "test-key", headers: {}, ok: true })),
		getAvailable: vi.fn(() => models),
	};
	ctx.ui = { ...ctx.ui, setWidget: vi.fn() };

	return ctx;
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
	it("auto-detects the current Anthropic Haiku model id", async () => {
		await runSummary([
			{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
		]);

		expect(mockedComplete).toHaveBeenCalledWith(
			expect.objectContaining({ id: "claude-haiku-4-5", provider: "anthropic" }),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("auto-detects the local qwen2.5-coder 14b profile model", async () => {
		await runSummary([
			{ id: "qwen2.5-coder:14b", name: "Qwen2.5 Coder 14B", provider: "llama-swap" },
		]);

		expect(mockedComplete).toHaveBeenCalledWith(
			expect.objectContaining({ id: "qwen2.5-coder:14b", provider: "llama-swap" }),
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
				roles: { "summary.session": "gemini-3-flash" },
				tools: { "smart-sessions.summary": { role: "summary.session" } },
			}),
		);

		await runSummary([
			{ id: "gpt-5.4-mini", name: "GPT 5.4 Mini", provider: "openai" },
			{ id: "gemini-3-flash", name: "Gemini 3 Flash", provider: "google" },
		]);

		expect(mockedComplete).toHaveBeenCalledWith(
			expect.objectContaining({ id: "gemini-3-flash", provider: "google" }),
			expect.any(Object),
			expect.any(Object),
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

		expect(mockedComplete).toHaveBeenCalledWith(
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

		expect(mockedComplete).not.toHaveBeenCalled();
		expect(ctx.modelRegistry.find).toHaveBeenCalledWith("anthropic", "missing-model");
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(
			"session-summary",
			expect.arrayContaining([expect.stringContaining("MODEL_NOT_FOUND")]),
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
