import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	fauxAssistantMessage,
	fauxText,
	type AssistantMessage,
	type Context,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	calls,
	createTestSession,
	says,
	type TestSession,
	when,
} from "./helpers/faux-session.js";

const PROJECT_ROOT = resolve(__dirname, "../..");
const MODES_EXTENSION = resolve(PROJECT_ROOT, "extensions/modes/src/index.ts");
const SMART_TOOL_GUARDS_EXTENSION = resolve(PROJECT_ROOT, "extensions/smart-tool-guards/index.ts");
const CLASSIFIER_PROMPT_PREFIX = "You are a strict policy classifier.";
const ALLOW = '{"version":1,"decision":"allow"}';
const BLOCK = '{"version":1,"decision":"block","reason":"classifier blocked"}';

type Router = (context: Context) => AssistantMessage | Promise<AssistantMessage | undefined> | undefined;

function classifierPayload(context: Context): Record<string, unknown> | undefined {
	if (!context.systemPrompt.startsWith(CLASSIFIER_PROMPT_PREFIX)) return undefined;
	const message = context.messages.at(-1);
	const content = message?.role === "user" && Array.isArray(message.content) ? message.content[0] : undefined;
	if (!content || typeof content === "string" || content.type !== "text") {
		throw new Error("Expected classifier text payload");
	}
	return JSON.parse(content.text) as Record<string, unknown>;
}

function writeClassifierConfig(session: TestSession, cwd: string): void {
	const model = session.session.model;
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi/tool_models.json"), JSON.stringify({
		version: 1,
		roles: { "guard.tool": `${model.provider}/${model.id}:low` },
		tools: { "smart-tool-guards.classifier": { role: "guard.tool" } },
	}));
}

function bashUpdates(session: TestSession): number {
	return session.events.all.filter((event) =>
		event.type === "tool_execution_update" && event.toolName === "bash"
	).length;
}

describe("smart-tool-guards native bash — integration", () => {
	const sessions: TestSession[] = [];
	const roots: string[] = [];

	function tempRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "smart-tool-guards-native-"));
		roots.push(root);
		return root;
	}

	async function create(root: string, extensions: string[], router?: Router): Promise<TestSession> {
		const session = await createTestSession({
			cwd: root,
			extensions,
			propagateErrors: false,
			fauxResponseRouter: router,
		});
		sessions.push(session);
		return session;
	}

	async function guarded(root: string, router?: Router): Promise<TestSession> {
		const session = await create(root, [MODES_EXTENSION, SMART_TOOL_GUARDS_EXTENSION], router);
		writeClassifierConfig(session, root);
		await session.session.prompt("/mode fuxi");
		return session;
	}

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
			expect(existsSync(root)).toBe(false);
		}
	});

	it("executes exact pwd through native bash with zero classifier calls", async () => {
		const root = tempRoot();
		let classifierCalls = 0;
		const session = await guarded(root, (context) => {
			if (!classifierPayload(context)) return undefined;
			classifierCalls += 1;
			return fauxAssistantMessage([fauxText(ALLOW)], { stopReason: "stop" });
		});
		await session.run(when("Print cwd", [calls("bash", { command: "pwd" }), says("Done.")]));

		expect(classifierCalls).toBe(0);
		expect(session.events.toolResultsFor("bash")[0]).toMatchObject({ isError: false, mocked: false });
		expect(session.events.toolResultsFor("bash")[0].text).toBe(`${root}\n`);
		expect(session.events.toolCallsFor("bash")[0].input).toEqual({ command: "pwd" });
		expect(bashUpdates(session)).toBeGreaterThan(0);
	});

	it("strictly allows deferred native bash in requested cwd and preserves timeout presence", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "marker"), "safe");
		const payloads: Record<string, unknown>[] = [];
		const session = await guarded(root, (context) => {
			const payload = classifierPayload(context);
			if (!payload) return undefined;
			payloads.push(payload);
			return fauxAssistantMessage([fauxText(ALLOW)], { stopReason: "stop" });
		});
		const withTimeout = "test -f marker && printf cwd-ok";
		const withoutTimeout = "test -f marker && printf no-timeout";
		await session.run(
			when("Check marker with timeout", [calls("bash", { command: withTimeout, cwd: ".", timeout: 3 }), says("Done.")]),
			when("Check marker without timeout", [calls("bash", { command: withoutTimeout, cwd: "." }), says("Done.")]),
		);

		expect(payloads).toHaveLength(2);
		expect(payloads[0]).toEqual({
			target: "bash",
			action: { command: withTimeout, requestedCwd: ".", requestedTimeout: 3 },
			context: { effectiveCwd: root },
		});
		expect(payloads[1]).toEqual({
			target: "bash",
			action: { command: withoutTimeout, requestedCwd: "." },
			context: { effectiveCwd: root },
		});
		expect(Object.hasOwn(payloads[1].action as object, "requestedTimeout")).toBe(false);
		expect(session.events.toolResultsFor("bash").map(({ text, mocked }) => ({ text, mocked }))).toEqual([
			{ text: "cwd-ok", mocked: false },
			{ text: "no-timeout", mocked: false },
		]);
		expect(session.events.toolCallsFor("bash").map(({ input }) => input)).toEqual([
			{ command: withTimeout, cwd: ".", timeout: 3 },
			{ command: withoutTimeout, cwd: "." },
		]);
		expect(readFileSync(join(root, "marker"), "utf8")).toBe("safe");
	});

	it("blocks deterministic hazards before classifier and native executor", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "sentinel"), "intact");
		let classifierCalls = 0;
		const session = await guarded(root, (context) => {
			if (!classifierPayload(context)) return undefined;
			classifierCalls += 1;
			return fauxAssistantMessage([fauxText(ALLOW)], { stopReason: "stop" });
		});
		const commands = [
			"printf owned > sentinel",
			"echo ok; /bin/rm sentinel",
			"command /bin/rm sentinel",
			"git reset --hard",
		];
		await session.run(...commands.map((command) =>
			when(command, [calls("bash", { command }), says("Blocked.")])
		));

		expect(classifierCalls).toBe(0);
		expect(bashUpdates(session)).toBe(0);
		expect(session.events.toolCallsFor("bash").map(({ input }) => input.command)).toEqual(commands);
		expect(session.events.toolResultsFor("bash")).toHaveLength(commands.length);
		const policyMessage = /^\[Smart Guard\]\[BLOCK\]\[source=policy\]\[profile=bash-read-only-v1\]\[scope=modes:fuxi\]\nBash not run: Read-only policy matched: [^\n]+\. Guard active: Fuxi plan mode requires read-only Bash\.$/;
		expect(session.events.toolResultsFor("bash").every(
			({ isError, text }) => isError && policyMessage.test(text),
		)).toBe(true);
		expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("intact");
	});

	it.each([
		["block", BLOCK, [
			"[Smart Guard][BLOCK][source=classifier][profile=bash-read-only-v1][scope=modes:fuxi]",
			"Bash not run: classifier blocked. Guard active: Fuxi plan mode requires read-only Bash.",
		].join("\n")],
		["malformed", "not-json", [
			"[Smart Guard][ERROR][source=classifier][profile=bash-read-only-v1][scope=modes:fuxi]",
			"Bash not run: Classifier unavailable; guard failed closed. Guard active: Fuxi plan mode requires read-only Bash.",
		].join("\n")],
	] as const)("preserves sentinel when classifier returns %s", async (_case, verdict, expectedMessage) => {
		const root = tempRoot();
		writeFileSync(join(root, "sentinel"), "intact");
		let classifierCalls = 0;
		const session = await guarded(root, (context) => {
			if (!classifierPayload(context)) return undefined;
			classifierCalls += 1;
			return fauxAssistantMessage([fauxText(verdict)], { stopReason: "stop" });
		});
		const command = "test -f sentinel && printf would-run";
		await session.run(when("Classifier case", [calls("bash", { command }), says("Blocked.")]));

		expect(classifierCalls).toBe(1);
		expect(bashUpdates(session)).toBe(0);
		expect(session.events.toolCallsFor("bash")[0].input).toEqual({ command });
		expect(session.events.toolResultsFor("bash")[0]).toMatchObject({ isError: true, mocked: false });
		expect(session.events.toolResultsFor("bash")[0].text).toBe(expectedMessage);
		expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("intact");
	});

	it("fails closed on classifier abort without starting native executor", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "sentinel"), "intact");
		let classifierCalls = 0;
		const session = await guarded(root, (context) => {
			if (!classifierPayload(context)) return undefined;
			classifierCalls += 1;
			throw new DOMException("classifier timed out", "AbortError");
		});
		const command = "test -f sentinel && printf would-run";
		await session.run(when("Aborted classifier", [calls("bash", { command }), says("Blocked.")]));

		expect(classifierCalls).toBe(1);
		expect(bashUpdates(session)).toBe(0);
		expect(session.events.toolCallsFor("bash")[0].input).toEqual({ command });
		expect(session.events.toolResultsFor("bash")[0]).toMatchObject({ isError: true, mocked: false });
		expect(session.events.toolResultsFor("bash")[0].text).toBe([
			"[Smart Guard][ERROR][source=classifier][profile=bash-read-only-v1][scope=modes:fuxi]",
			"Bash not run: Classifier unavailable; guard failed closed. Guard active: Fuxi plan mode requires read-only Bash.",
		].join("\n"));
		expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("intact");
	});

	it("fails closed when classifier is unavailable without starting native executor", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "sentinel"), "intact");
		const session = await guarded(root);
		rmSync(join(root, ".pi/tool_models.json"));
		const command = "test -f sentinel && printf would-run";
		await session.run(when("Unavailable classifier", [calls("bash", { command }), says("Blocked.")]));

		expect(bashUpdates(session)).toBe(0);
		expect(session.events.toolResultsFor("bash")[0].text).toBe([
			"[Smart Guard][ERROR][source=classifier][profile=bash-read-only-v1][scope=modes:fuxi]",
			"Bash not run: Classifier unavailable; guard failed closed. Guard active: Fuxi plan mode requires read-only Bash.",
		].join("\n"));
		expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("intact");
	});

	it("keeps concurrent classifier verdicts isolated", async () => {
		const allowRoot = tempRoot();
		const blockRoot = tempRoot();
		writeFileSync(join(allowRoot, "marker"), "allow");
		writeFileSync(join(blockRoot, "marker"), "block");
		const requests: string[] = [];
		const verdictResolvers = new Map<string, (message: AssistantMessage) => void>();
		let markBothObserved: (() => void) | undefined;
		const bothObserved = new Promise<void>((resolveBoth) => {
			markBothObserved = resolveBoth;
		});
		const route: Router = async (context) => {
			const payload = classifierPayload(context);
			if (!payload) return undefined;
			const action = payload.action as { command: string };
			requests.push(action.command);
			return new Promise<AssistantMessage>((resolveVerdict) => {
				verdictResolvers.set(action.command, resolveVerdict);
				if (verdictResolvers.size === 2) markBothObserved?.();
			});
		};
		const allowSession = await guarded(allowRoot, route);
		const blockSession = await guarded(blockRoot, route);
		const allowCommand = "test -f marker && printf concurrent-allow";
		const blockCommand = "test -f marker && printf concurrent-block";
		const runs = Promise.all([
			allowSession.run(when("Allow concurrently", [calls("bash", { command: allowCommand }), says("Done.")])),
			blockSession.run(when("Block concurrently", [calls("bash", { command: blockCommand }), says("Blocked.")])),
		]);
		await bothObserved;
		expect(requests.sort()).toEqual([allowCommand, blockCommand].sort());
		const resolveBlock = verdictResolvers.get(blockCommand);
		const resolveAllow = verdictResolvers.get(allowCommand);
		if (!resolveBlock || !resolveAllow) throw new Error("Expected both classifier verdict resolvers");
		resolveBlock(fauxAssistantMessage([fauxText(BLOCK)], { stopReason: "stop" }));
		resolveAllow(fauxAssistantMessage([fauxText(ALLOW)], { stopReason: "stop" }));
		await runs;

		expect(allowSession.events.toolResultsFor("bash")[0]).toMatchObject({ text: "concurrent-allow", isError: false, mocked: false });
		expect(blockSession.events.toolResultsFor("bash")[0]).toMatchObject({ isError: true, mocked: false });
		expect(blockSession.events.toolResultsFor("bash")[0].text).toBe([
			"[Smart Guard][BLOCK][source=classifier][profile=bash-read-only-v1][scope=modes:fuxi]",
			"Bash not run: classifier blocked. Guard active: Fuxi plan mode requires read-only Bash.",
		].join("\n"));
		expect(readFileSync(join(allowRoot, "marker"), "utf8")).toBe("allow");
		expect(readFileSync(join(blockRoot, "marker"), "utf8")).toBe("block");
	});

	it("blocks Fu Xi bash when smart-tool-guards capability is missing", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "sentinel"), "intact");
		const session = await create(root, [MODES_EXTENSION]);
		await session.session.prompt("/mode fuxi");
		await session.run(when("Missing capability", [calls("bash", { command: "pwd" }), says("Blocked.")]));

		expect(bashUpdates(session)).toBe(0);
		expect(session.events.toolResultsFor("bash")[0].text).toMatch(/smart guard capability is not registered/i);
		expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("intact");
	});

	it("leaves adjacent unguarded Kuafu native bash unchanged", async () => {
		const root = tempRoot();
		let classifierCalls = 0;
		const session = await create(root, [MODES_EXTENSION, SMART_TOOL_GUARDS_EXTENSION], (context) => {
			if (!classifierPayload(context)) return undefined;
			classifierCalls += 1;
			return fauxAssistantMessage([fauxText(BLOCK)], { stopReason: "stop" });
		});
		const command = "printf adjacent-ok";
		await session.run(when("Adjacent path", [calls("bash", { command }), says("Done.")]));

		expect(classifierCalls).toBe(0);
		expect(session.events.toolCallsFor("bash")[0].input).toEqual({ command });
		expect(session.events.toolResultsFor("bash")[0]).toMatchObject({ text: "adjacent-ok", isError: false, mocked: false });
		expect(bashUpdates(session)).toBeGreaterThan(0);
	});
});
