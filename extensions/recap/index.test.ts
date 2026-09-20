// Derived from L2ncE/pi-recap at commit 02057d0; modified by Panda Harness. See README.md and LICENSE.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import recapExtension from "./index.js";

type TestModel = { provider: string; id: string; name: string };
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type CommandHandler = (args: string, ctx: unknown) => Promise<unknown>;

type FakeContext = {
	cwd: string;
	hasUI: boolean;
	model: TestModel;
	modelRegistry: {
		find(provider: string, id: string): TestModel | undefined;
		getAll(): TestModel[];
		getAvailable(): TestModel[];
		hasConfiguredAuth(candidate: TestModel): boolean;
		complete: ReturnType<typeof vi.fn>;
	};
	sessionManager: { getBranch(): unknown[] };
	ui: {
		notify: ReturnType<typeof vi.fn>;
		setWidget: ReturnType<typeof vi.fn>;
	};
};

function model(provider: string, id: string): TestModel {
	return { provider, id, name: id };
}

function sessionBranch(recap?: string): unknown[] {
	const state = recap ? [{ type: "custom", customType: "pi-recap", data: { recap, goal: "original goal" } }] : [];
	return [
		...state,
		{ type: "message", message: { role: "user", content: "original goal" } },
		{ type: "message", message: { role: "assistant", content: "first response" } },
		{ type: "message", message: { role: "user", content: "second turn" } },
		{ type: "message", message: { role: "assistant", content: "second response" } },
		{ type: "message", message: { role: "user", content: "third turn" } },
		{ type: "message", message: { role: "assistant", content: "third response" } },
	];
}

function activate() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, CommandHandler>();
	const appendEntry = vi.fn();
	const on = (...args: unknown[]) => {
		const [event, handler] = args;
		if (typeof event !== "string" || !isFunction(handler)) return;
		handlers.set(event, async (payload, ctx) => handler(payload, ctx));
	};
	const registerCommand = (...args: unknown[]) => {
		const [name, command] = args;
		if (typeof name !== "string" || !isRecord(command)) return;
		const handler = command.handler;
		if (!isFunction(handler)) return;
		commands.set(name, async (args, ctx) => handler(args, ctx));
	};
	Reflect.apply(recapExtension, undefined, [{ on, registerCommand, appendEntry }]);
	return { appendEntry, commands, handlers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

function context(cwd: string, branch: unknown[], completion: ReturnType<typeof vi.fn>, configuredModels: TestModel[] = [model("fixture", "recap")]): FakeContext {
	return {
		cwd,
		hasUI: true,
		model: model("session", "current"),
		modelRegistry: {
			find(provider, id) {
				return configuredModels.find((configured) => provider === configured.provider && id === configured.id);
			},
			getAll() {
				return configuredModels;
			},
			getAvailable() {
				return configuredModels;
			},
			hasConfiguredAuth(candidate) {
				return configuredModels.some((configured) => candidate.provider === configured.provider && candidate.id === configured.id);
			},
			complete: completion,
		},
		sessionManager: { getBranch: () => branch },
		ui: { notify: vi.fn(), setWidget: vi.fn() },
	};
}

describe("recap lifecycle", () => {
	let root = "";
	let agentDir = "";
	let cwd = "";
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "recap-lifecycle-test-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "tool_models.json"), JSON.stringify({ version: 1, roles: { "summary.session": "fixture/recap" } }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ recap: { maxWords: 1, placement: "above", model: "fixture/ignored" } }));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ recap: { maxWords: 2 } }));
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(root, { force: true, recursive: true });
	});

	it("generates through tool-model policy and preserves settings precedence", async () => {
		const activation = activate();
		const completion = vi.fn().mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "one two three" }] });
		const ctx = context(cwd, sessionBranch(), completion);

		await activation.handlers.get("session_start")?.({}, ctx);
		await activation.commands.get("recap")?.("", ctx);

		expect(completion.mock.calls[0]?.[0]).toEqual(model("fixture", "recap"));
		expect(activation.appendEntry).toHaveBeenLastCalledWith("pi-recap", expect.objectContaining({ recap: "one two…" }));
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-recap", expect.any(Function), { placement: "aboveEditor" });
	});

	it("keeps a restored recap when every completion candidate fails", async () => {
		const activation = activate();
		const completion = vi.fn().mockRejectedValue(new Error("provider unavailable"));
		const ctx = context(cwd, sessionBranch("previous recap"), completion);

		await activation.handlers.get("session_start")?.({}, ctx);
		await activation.commands.get("recap")?.("", ctx);

		expect(activation.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Recap skipped: generation failed", "warning");
		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
	});
	it("uses each configured candidate thinking level for its completion attempt", async () => {
		const first = model("fixture", "first");
		const fallback = model("fixture", "fallback");
		writeFileSync(join(agentDir, "tool_models.json"), JSON.stringify({ version: 1, roles: { "summary.session": "fixture/first:low,fixture/fallback:medium" } }));
		const activation = activate();
		const completion = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "recap" }] });
		const ctx = context(cwd, sessionBranch(), completion, [first, fallback]);

		await activation.handlers.get("session_start")?.({}, ctx);
		await activation.commands.get("recap")?.("", ctx);

		expect(completion.mock.calls.map(([, , options]) => options.reasoningEffort)).toEqual(["low", "medium"]);
	});

});
