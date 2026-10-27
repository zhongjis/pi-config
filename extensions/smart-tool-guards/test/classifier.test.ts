import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify } from "../src/classifier.js";


const completeMock = vi.fn();
const classifyMock = vi.fn();
const PRIMARY = { id: "classifier-primary", name: "Primary", provider: "test-primary" };
const FALLBACK = { id: "classifier-fallback", name: "Fallback", provider: "test-fallback" };
const SESSION = { id: "session-model", name: "Session", provider: "test-session" };
const LABELER = { id: "labeler-1", name: "Labeler", provider: "test-labels" };
const ALLOW_RESPONSE = {
	stopReason: "stop",
	content: [{ type: "text", text: '{"version":1,"decision":"allow"}' }],
};
const REQUEST = {
	policyId: "bash-plan-v1" as const,
	policyInstructions: "Allow only read-only planning actions.",
	choices: {
		allow: "read_only",
		criteria: { read_only: "Only reads.", mutates_state: "Changes state.", runs_code: "Runs code." },
	},
	target: "bash" as const,
	action: { command: "echo hello" },
	context: { cwd: "/repo/workspace", timeout: 90_000 },
};

type Auth = { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string };
type ClassifierModel = { id: string; name: string; provider: string };

function configured(auth: Auth | undefined): boolean {
	if (!auth) return true;
	return auth.ok && Boolean(auth.apiKey);
}

function writeClassifierConfig(cwd: string, chain = "test-primary/classifier-primary:low,test-fallback/classifier-fallback"): void {
	const configDir = join(cwd, ".pi");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "tool_models.json"), JSON.stringify({
		version: 1,
		roles: { "guard.tool": chain },
		tools: { "smart-tool-guards.classifier": { role: "guard.tool" } },
	}));
}

function makeContext(cwd: string, options: {
	available?: ClassifierModel[];
	auth?: Auth;
	model?: ClassifierModel;
	unauthenticated?: ClassifierModel[];
	classifiers?: ClassifierModel[];
	availableClassifiers?: ClassifierModel[] | Error;
	readonly signal?: AbortSignal;
} = {}) {
	const available = options.available ?? [PRIMARY];
	const unauthenticated = options.unauthenticated ?? [];
	const classifiers = options.classifiers ?? [];
	const availableClassifiers = options.availableClassifiers ?? classifiers;
	return {
		cwd,
		model: options.model,
		signal: options.signal,
		modelRegistry: {
			find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
			getAll: () => available,
			getAvailable: () => available,
			hasConfiguredAuth: (model: ClassifierModel) =>
				!unauthenticated.some((item) => item.provider === model.provider && item.id === model.id)
				&& configured(options.auth),
			complete: completeMock,
			findOfType: (type: string, provider: string, id: string) =>
				type === "classifier" ? classifiers.find((model) => model.provider === provider && model.id === id) : undefined,
			getAvailableOfType: async (type: string, provider: string) => {
				if (availableClassifiers instanceof Error) throw availableClassifiers;
				return type === "classifier" ? availableClassifiers.filter((model) => model.provider === provider) : [];
			},
			classify: classifyMock,
		},
	};
}

function choiceResult(probabilities: Record<string, number>, stopReason = "stop") {
	return {
		stopReason,
		answers: { verdict: { type: "choice", choice: "read_only", probabilities, confidence: 0.9 } },
	};
}

describe("smart-tool-guards classifier", () => {
	let root: string;
	let cwd: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		completeMock.mockReset();
		completeMock.mockResolvedValue(ALLOW_RESPONSE as never);
		classifyMock.mockReset();
		root = mkdtempSync(join(tmpdir(), "smart-tool-guards-classifier-"));
		cwd = join(root, "project");
		mkdirSync(cwd);
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(root, { force: true, recursive: true });
	});

	it("keeps trusted policy separate from the untrusted request payload", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd);

		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
		expect(completeMock).toHaveBeenCalledOnce();
		const call = completeMock.mock.calls.at(0);
		if (!call) throw new TypeError("classifier did not call the model");
		const [model, prompt, options] = call;

		expect(model).toBe(PRIMARY);
		expect(options).toMatchObject({ reasoningEffort: "low" });
		expect(options).not.toHaveProperty("apiKey");
		expect(options).not.toHaveProperty("headers");
		expect(prompt.systemPrompt).toContain(`Trusted policy ID: ${REQUEST.policyId}`);
		expect(prompt.systemPrompt).toContain(REQUEST.policyInstructions);
		expect(prompt.systemPrompt).not.toContain(REQUEST.action.command);
		expect(prompt.systemPrompt).toContain('{"version":1,"decision":"allow"}');
		expect(prompt.systemPrompt).toContain('{"version":1,"decision":"block","reason":"nonblank explanation"}');

		const userMessage = prompt.messages.at(0);
		if (!userMessage || typeof userMessage.content === "string") {
			throw new TypeError("classifier request had no structured user payload");
		}
		const textPart = userMessage.content.at(0);
		if (textPart?.type !== "text") throw new TypeError("classifier request payload was not text");
		expect(JSON.parse(textPart.text)).toEqual({
			target: REQUEST.target,
			action: REQUEST.action,
			context: REQUEST.context,
		});
		expect(textPart.text).not.toContain(REQUEST.policyInstructions);
	});

	it("returns exact allow and block result variants", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd);
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });

		completeMock.mockResolvedValueOnce({
			stopReason: "stop",
			content: [{ type: "text", text: '{"version":1,"decision":"block","reason":"  writes files  "}' }],
		} as never);
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "block", reason: "writes files" });
	});

	it("uses the first available model from the configured fallback chain", async () => {
		writeClassifierConfig(cwd);
		await classify(REQUEST, makeContext(cwd, { available: [FALLBACK] }) as never);
		expect(completeMock).toHaveBeenCalledWith(
			FALLBACK,
			expect.any(Object),
			expect.objectContaining({ reasoningEffort: undefined }),
		);
	});

	it("falls back to the current session model when the guard chain is unavailable", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd, { available: [], model: SESSION });
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
		expect(completeMock).toHaveBeenCalledWith(
			SESSION,
			expect.any(Object),
			expect.objectContaining({ reasoningEffort: undefined }),
		);
	});

	it("returns unavailable when both the guard chain and session model are unavailable", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd, { available: [], model: SESSION, auth: { ok: false, error: "no session auth" } });
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "unavailable", reason: "Classifier unavailable." });
		expect(completeMock).not.toHaveBeenCalled();
	});

	it("prefers the guard chain over the session model when both are available", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd, { available: [PRIMARY], model: SESSION });
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
		expect(completeMock).toHaveBeenCalledWith(
			PRIMARY,
			expect.any(Object),
			expect.objectContaining({ reasoningEffort: "low" }),
		);
	});

	it("falls through when the first candidate has no configured auth", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd, { available: [PRIMARY], model: SESSION, unauthenticated: [PRIMARY] });
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
		expect(completeMock).toHaveBeenCalledTimes(1);
		expect(completeMock.mock.calls[0]?.[0]).toBe(SESSION);
		expect(completeMock.mock.calls[0]?.[2]).not.toHaveProperty("apiKey");
		expect(completeMock.mock.calls[0]?.[2]).not.toHaveProperty("headers");
	});

	it("falls back to the session model when the guard chain model fails at completion", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd, { available: [PRIMARY], model: SESSION });
		completeMock.mockRejectedValueOnce(new Error("primary provider exploded"));
		completeMock.mockResolvedValueOnce(ALLOW_RESPONSE as never);
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
		expect(completeMock).toHaveBeenCalledTimes(2);
		expect(completeMock.mock.calls[0]?.[0]).toBe(PRIMARY);
		expect(completeMock.mock.calls[1]?.[0]).toBe(SESSION);
	});

	it("falls back to the session model when the guard chain returns a malformed verdict", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd, { available: [PRIMARY], model: SESSION });
		completeMock.mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "not json" }] } as never);
		completeMock.mockResolvedValueOnce(ALLOW_RESPONSE as never);
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it("returns the guard chain block without consulting the session model", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd, { available: [PRIMARY], model: SESSION });
		completeMock.mockResolvedValueOnce({
			stopReason: "stop",
			content: [{ type: "text", text: '{"version":1,"decision":"block","reason":"nope"}' }],
		} as never);
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "block", reason: "nope" });
		expect(completeMock).toHaveBeenCalledTimes(1);
		expect(completeMock.mock.calls[0]?.[0]).toBe(PRIMARY);
	});

	it("fails closed when both the guard chain and session model fail at completion", async () => {
		writeClassifierConfig(cwd);
		const ctx = makeContext(cwd, { available: [PRIMARY], model: SESSION });
		completeMock.mockRejectedValue(new Error("all providers down"));
		await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "unavailable", reason: "Classifier unavailable." });
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it("passes an independent five-second deadline signal", async () => {
		writeClassifierConfig(cwd);
		const controller = new AbortController();
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		await classify(REQUEST, makeContext(cwd) as never);
		expect(timeoutSpy).toHaveBeenCalledWith(5_000);
		expect(completeMock.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
	});

	it("fails closed when caller cancellation reaches a pending classifier request", async () => {
		writeClassifierConfig(cwd);
		const caller = new AbortController();
		let nestedSignal: AbortSignal | undefined;
		let settleRequest: (() => void) | undefined;
		completeMock.mockImplementation((_model, _context, options) => new Promise((resolve, reject) => {
			nestedSignal = options?.signal;
			settleRequest = () => {
				if (nestedSignal?.aborted) reject(new DOMException("cancelled", "AbortError"));
				else resolve(ALLOW_RESPONSE as never);
			};
		}));

		const pending = classify(REQUEST, makeContext(cwd, { signal: caller.signal }) as never);
		await vi.waitFor(() => expect(settleRequest).toBeTypeOf("function"));
		caller.abort();
		settleRequest?.();

		await expect(pending).resolves.toEqual({ kind: "unavailable", reason: "Classifier unavailable." });
	});

	it("keeps concurrent requests isolated", async () => {
		writeClassifierConfig(cwd);
		const resolvers: Array<(text: string) => void> = [];
		completeMock.mockImplementation(() => new Promise((resolve) => {
			resolvers.push((text) => resolve({ stopReason: "stop", content: [{ type: "text", text }] } as never));
		}));
		const ctx = makeContext(cwd);
		const first = classify({ ...REQUEST, action: { command: "first" } }, ctx as never);
		const second = classify({ ...REQUEST, action: { command: "second" } }, ctx as never);
		await vi.waitFor(() => expect(resolvers).toHaveLength(2));
		resolvers[1]('{"version":1,"decision":"block","reason":"second"}');
		resolvers[0]('{"version":1,"decision":"allow"}');
		await expect(Promise.all([first, second])).resolves.toEqual([
			{ kind: "allow" },
			{ kind: "block", reason: "second" },
		]);
		const payloads = completeMock.mock.calls.map((call) => {
			const content = call[1].messages[0].content[0];
			if (typeof content === "string" || content.type !== "text") throw new Error("Expected text classifier payload");
			return JSON.parse(content.text);
		});
		expect(payloads.map((payload) => payload.action.command)).toEqual(["first", "second"]);
	});

	it.each([
		["missing config", false, makeContext],
		["missing model", true, (path: string) => makeContext(path, { available: [] })],
		["missing auth", true, (path: string) => makeContext(path, { auth: { ok: false, error: "missing secret" } })],
		["blank auth", true, (path: string) => makeContext(path, { auth: { ok: true } })],
	] as const)("returns unavailable for %s", async (_name, configured, contextFactory) => {
		if (configured) writeClassifierConfig(cwd);
		await expect(classify(REQUEST, contextFactory(cwd) as never)).resolves.toEqual({
			kind: "unavailable",
			reason: "Classifier unavailable.",
		});
		expect(completeMock).not.toHaveBeenCalled();
	});

	it.each([
		["provider throw", () => completeMock.mockRejectedValue(new Error("provider secret output"))],
		["timeout or abort", () => completeMock.mockRejectedValue(new DOMException("timed out", "AbortError"))],
	])("returns unavailable without exposing transport output on %s", async (_name, setupFailure) => {
		writeClassifierConfig(cwd);
		setupFailure();
		const result = await classify(REQUEST, makeContext(cwd) as never);
		expect(result).toEqual({ kind: "unavailable", reason: "Classifier unavailable." });
		expect(JSON.stringify(result)).not.toContain("secret output");
	});

	it.each([
		["non-stop", { stopReason: "length", content: [{ type: "text", text: '{"version":1,"decision":"allow"}' }] }],
		["non-text", { stopReason: "stop", content: [{ type: "thinking", thinking: "private rationale" }] }],
		["tool call", { stopReason: "stop", content: [{ type: "text", text: '{"version":1,"decision":"allow"}' }, { type: "toolCall" }] }],
		["empty content", { stopReason: "stop", content: [] }],
	] as const)("returns unavailable for %s response", async (_name, response) => {
		writeClassifierConfig(cwd);
		completeMock.mockResolvedValue(response as never);
		await expect(classify(REQUEST, makeContext(cwd) as never)).resolves.toEqual({
			kind: "unavailable",
			reason: "Classifier unavailable.",
		});
	});

	describe("classifier models in the chain", () => {
		const LABELER_CHAIN = "test-labels/labeler-1:low,test-fallback/classifier-fallback";

		it("classifies with the classifier model and allows at the 0.85 threshold", async () => {
			writeClassifierConfig(cwd, LABELER_CHAIN);
			classifyMock.mockResolvedValue(choiceResult({ read_only: 0.85, mutates_state: 0.1, runs_code: 0.05 }));
			const ctx = makeContext(cwd, { available: [FALLBACK], classifiers: [LABELER], model: SESSION });

			await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
			expect(completeMock).not.toHaveBeenCalled();
			expect(classifyMock).toHaveBeenCalledOnce();
			const [model, context, options] = classifyMock.mock.calls[0] ?? [];
			expect(model).toBe(LABELER);
			expect(context.state).toEqual({
				target: REQUEST.target,
				untrusted_action: REQUEST.action,
				context: REQUEST.context,
			});
			expect(JSON.stringify(context.state)).not.toContain(REQUEST.policyInstructions);
			expect(context.questions.verdict).toMatchObject({ type: "choice", criteria: REQUEST.choices.criteria });
			expect(context.questions.verdict.instructions).toContain(REQUEST.policyInstructions);
			expect(context.questions.verdict.instructions).not.toContain(REQUEST.action.command);
			expect(options.signal).toBeInstanceOf(AbortSignal);
		});

		it("blocks below the threshold and names the most likely non-allow label", async () => {
			writeClassifierConfig(cwd, LABELER_CHAIN);
			classifyMock.mockResolvedValue(choiceResult({ read_only: 0.84, mutates_state: 0.04, runs_code: 0.12 }));
			const ctx = makeContext(cwd, { classifiers: [LABELER], model: SESSION });

			await expect(classify(REQUEST, ctx as never)).resolves.toEqual({
				kind: "block",
				reason: "runs_code: Runs code. (p(read_only)=0.84)",
			});
			expect(completeMock).not.toHaveBeenCalled();
		});

		it.each([
			["error stop reason", { stopReason: "error", answers: {}, errorMessage: "provider secret output" }],
			["missing answer", { stopReason: "stop", answers: {} }],
			["wrong answer type", { stopReason: "stop", answers: { verdict: { type: "bool", probability: 1 } } }],
			["missing allow probability", choiceResult({ mutates_state: 0.9 })],
		])("falls back to the session model on %s", async (_name, result) => {
			writeClassifierConfig(cwd, LABELER_CHAIN);
			classifyMock.mockResolvedValue(result);
			const ctx = makeContext(cwd, { classifiers: [LABELER], model: SESSION });

			await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
			expect(completeMock).toHaveBeenCalledOnce();
			expect(completeMock.mock.calls[0]?.[0]).toBe(SESSION);
		});

		it("fails closed when the classifier model and session model both give no verdict", async () => {
			writeClassifierConfig(cwd, LABELER_CHAIN);
			classifyMock.mockRejectedValue(new Error("down"));
			completeMock.mockRejectedValue(new Error("down"));
			const ctx = makeContext(cwd, { classifiers: [LABELER], model: SESSION });

			await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "unavailable", reason: "Classifier unavailable." });
		});

		it.each([
			["not in the available list", []],
			["availability lookup fails", new Error("auth lookup failed")],
		] as const)("skips a classifier model that is %s and uses the next chain entry", async (_name, availableClassifiers) => {
			writeClassifierConfig(cwd, LABELER_CHAIN);
			const ctx = makeContext(cwd, {
				available: [FALLBACK],
				classifiers: [LABELER],
				availableClassifiers: availableClassifiers instanceof Error ? availableClassifiers : [...availableClassifiers],
				model: SESSION,
			});

			await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
			expect(classifyMock).not.toHaveBeenCalled();
			expect(completeMock.mock.calls[0]?.[0]).toBe(FALLBACK);
		});

		it("keeps chat behavior for an ID that is both an available chat and classifier model", async () => {
			writeClassifierConfig(cwd, "test-primary/classifier-primary:low");
			const ctx = makeContext(cwd, { available: [PRIMARY], classifiers: [PRIMARY] });

			await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
			expect(classifyMock).not.toHaveBeenCalled();
			expect(completeMock.mock.calls[0]?.[0]).toBe(PRIMARY);
		});

		it("uses a classifier model that comes after an unavailable chat entry", async () => {
			writeClassifierConfig(cwd, "test-primary/classifier-primary,test-labels/labeler-1");
			classifyMock.mockResolvedValue(choiceResult({ read_only: 0.99 }));
			const ctx = makeContext(cwd, { available: [], classifiers: [LABELER] });

			await expect(classify(REQUEST, ctx as never)).resolves.toEqual({ kind: "allow" });
			expect(classifyMock.mock.calls[0]?.[0]).toBe(LABELER);
		});
	});

	it("ignores provider thinking blocks around an exact text verdict", async () => {
		writeClassifierConfig(cwd);
		completeMock.mockResolvedValue({
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "private rationale" },
				{ type: "text", text: '{"version":1,"decision":"allow"}' },
			],
		} as never);
		await expect(classify(REQUEST, makeContext(cwd) as never)).resolves.toEqual({ kind: "allow" });
	});

	it.each([
		"not json",
		"```json\n{\"version\":1,\"decision\":\"allow\"}\n```",
		'{"version":2,"decision":"allow"}',
		'{"version":1,"decision":"allow","reason":"extra"}',
		'{"version":1,"decision":"block"}',
		'{"version":1,"decision":"block","reason":"   "}',
		'{"version":1,"decision":"block","reason":"no","extra":true}',
		'{"version":1,"decision":"other"}',
		'[{"version":1,"decision":"allow"}]',
	])("returns unavailable for malformed or non-exact verdict: %s", async (text) => {
		writeClassifierConfig(cwd);
		completeMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text }] } as never);
		await expect(classify(REQUEST, makeContext(cwd) as never)).resolves.toEqual({
			kind: "unavailable",
			reason: "Classifier unavailable.",
		});
	});
});
