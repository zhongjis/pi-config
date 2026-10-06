import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goalStoreRef } from "../../extensions/goal/src/goal/context.js";
import { readGoal } from "../../extensions/goal/src/goal/store.js";
import { createMockUIContext } from "./helpers/mock-ui.js";
import { calls, createTestSession, says, type TestSession, when } from "./helpers/faux-session.js";

const GOAL_EXTENSION = resolve(import.meta.dirname, "../../extensions/goal/index.ts");

describe("Goal in native Pi", () => {
	let test: TestSession | undefined;
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(resolve(tmpdir(), "pi-native-goal-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	});
	afterEach(async () => {
		await test?.session.abort();
		test?.dispose();
		test = undefined;
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	// A native cancellable tool is the synchronization seam, not a delivery receipt.
	function waitTool(entered: () => void, release?: Promise<void>) {
		return (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "goal_wait",
				label: "Wait",
				description: "Cancellation fixture",
				parameters: Type.Object({}),
				async execute(_id, _params, signal) {
					entered();
					await Promise.race([
						release ?? new Promise<void>(() => {}),
						new Promise<void>((resolve) => {
							if (signal?.aborted) resolve();
							else signal?.addEventListener("abort", () => resolve(), { once: true });
						}),
					]);
					return { content: [{ type: "text" as const, text: "Wait finished" }], details: {} };
				},
			});
		};
	}

	it.each([
		"Continue existing goal",
		"Keep paused",
		"dismiss",
		"no-ui",
	])("processes cancelled input once: %s", async (choice) => {
		let entered: () => void = () => {};
		let waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let activateULW = false;
		test = await createTestSession({
			extensions: [GOAL_EXTENSION],
			extensionFactories: [
				waitTool(() => entered()),
				(pi: ExtensionAPI) => {
					pi.on("input", (_event, ctx) => {
						if (activateULW) pi.events.emit("ulw:activated", { sessionId: ctx.sessionManager.getSessionId() });
					});
				},
			],
			mockUI: { select: () => (choice === "dismiss" ? undefined : choice) },
		});
		const session: AgentSession = test.session;
		await session.prompt("/goal");
		const initial = test.run(
			when("Create and wait", [
				calls("create_goal", { objective: "Original", token_budget: 100000 }),
				calls("goal_wait"),
			]),
		);
		await waiting;
		await session.abort();
		await initial;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		const paused = await readGoal(ref);
		expect(paused?.cancellationOffer).toEqual(expect.any(String));
		if (choice === "no-ui") await session.bindExtensions({});
		const starts = test.events.all.filter((event) => event.type === "agent_start").length;
		const amendment = "  Add </amendment> & keep original scope  ";
		activateULW = choice === "Continue existing goal";
		await test.run(
			when(
				amendment,
				choice === "Continue existing goal"
					? [calls("update_goal", { status: "complete" }), says("Done")]
					: [says("Answered outside the Goal")],
			),
		);
		const after = await readGoal(ref);
		expect(after).toMatchObject({
			id: paused?.id,
			objective: "Original",
			createdAt: paused?.createdAt,
			tokenBudget: paused?.tokenBudget,
			status: choice === "Continue existing goal" ? "complete" : "paused",
		});
		expect(after?.tokensUsed).toBeGreaterThanOrEqual(paused?.tokensUsed ?? 0);
		expect(after?.timeUsedSeconds).toBeGreaterThanOrEqual(paused?.timeUsedSeconds ?? 0);
		expect(after?.cancellationOffer).toBeUndefined();
		expect(after?.amendments).toEqual(choice === "Continue existing goal" ? [amendment] : undefined);
		expect(test.events.all.filter((event) => event.type === "agent_start")).toHaveLength(starts + 1);
		const entries = session.sessionManager.getEntries();
		expect(
			entries.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("Add </amendment>"),
			),
		).toHaveLength(1);
		const contexts = entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "pi-goal-continuation",
		);
		expect(contexts).toHaveLength(choice === "Continue existing goal" ? 1 : 0);
		if (activateULW)
			expect(
				entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-bootstrap"),
			).toHaveLength(1);
		if (choice === "Continue existing goal")
			expect(contexts[0]).toMatchObject({ details: { goalId: paused?.id, amendmentVersion: 1 } });
		const decisions = entries.filter(
			(entry) => entry.type === "custom" && entry.customType === "pi-goal-input-decision",
		);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			data: {
				goalId: paused?.id,
				source: "interactive",
				amendmentVersion: choice === "Continue existing goal" ? 1 : 0,
			},
		});
		expect(JSON.stringify(decisions)).not.toContain(amendment);
		expect(test.events.toolResults.every((result) => !result.isError)).toBe(true);
		if (choice !== "Continue existing goal") {
			await session.bindExtensions({});
			await test.run(when("Another question after restore", [says("Still paused")]));
			expect((await readGoal(ref))?.cancellationOffer).toBeUndefined();
			waiting = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const resumed = test.run(when("/goal resume", [calls("goal_wait")]));
			await waiting;
			await session.abort();
			await resumed;
			expect((await readGoal(ref))?.cancellationOffer).toEqual(expect.any(String));
			expect((await readGoal(ref))?.cancellationOffer).not.toBe(paused?.cancellationOffer);
		}
	});

	it.each([
		"interactive",
		"rpc",
	] as const)("accepts %s steer before delivery, survives abort and rearms another Stop", async (source) => {
		let entered: () => void = () => {};
		let waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let providerRequests = 0;
		test = await createTestSession({
			extensions: [GOAL_EXTENSION],
			extensionFactories: [waitTool(() => entered())],
			mockUI: { select: "Continue existing goal" },
			fauxResponseRouter: () => {
				providerRequests++;
				return undefined;
			},
		});
		const session: AgentSession = test.session;
		await session.prompt("/goal");
		const initial = test.run(when("Start work", [calls("create_goal", { objective: "Original" }), calls("goal_wait")]));
		await waiting;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		const requestsBeforeSteer = providerRequests;
		await session.prompt("  Steer before Stop  ", { source, streamingBehavior: "steer" });
		expect(await readGoal(ref)).toMatchObject({ status: "active", amendments: ["  Steer before Stop  "] });
		expect(test.events.ui.filter((call) => call.method === "select")).toHaveLength(0);
		await session.abort();
		await initial;
		const paused = await readGoal(ref);
		expect(paused).toMatchObject({ status: "paused", amendments: ["  Steer before Stop  "] });
		expect(paused?.cancellationOffer).toEqual(expect.any(String));
		// Native history may retain queued input; no provider request started after submission.
		expect(requestsBeforeSteer).toBeGreaterThan(0);
		expect(providerRequests).toBe(requestsBeforeSteer);
		const decision = session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "pi-goal-input-decision");
		expect(decision).toMatchObject({
			data: { goalId: paused?.id, decision: "steer-accepted", source, amendmentVersion: 1 },
		});
		waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const resumed = test.run(when("Continue with second amendment", [calls("goal_wait")]));
		await waiting;
		await session.abort();
		await resumed;
		const twice = await readGoal(ref);
		expect(twice).toMatchObject({
			id: paused?.id,
			status: "paused",
			amendments: ["  Steer before Stop  ", "Continue with second amendment"],
		});
		expect(twice?.cancellationOffer).toEqual(expect.any(String));
		expect(twice?.cancellationOffer).not.toBe(paused?.cancellationOffer);
	});

	it("refreshes command-started Goal context for two naturally delivered steers in one run", async () => {
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const providerInputs: string[] = [];
		const versions: unknown[][] = [];
		test = await createTestSession({
			extensions: [GOAL_EXTENSION],
			extensionFactories: [
				waitTool(entered, gate),
				(pi: ExtensionAPI) => {
					pi.on("context", (event) => {
						versions.push(
							event.messages.flatMap((message) =>
								message.role === "custom" && message.customType === "pi-goal-continuation" ? [message.details] : [],
							),
						);
					});
				},
			],
			fauxResponseRouter: (context) => {
				providerInputs.push(JSON.stringify(context.messages));
				return undefined;
			},
		});
		const session: AgentSession = test.session;
		const running = test.run(
			when("/goal Original command objective", [
				calls("goal_wait"),
				calls("update_goal", { status: "complete" }),
				says("Finished"),
			]),
		);
		await waiting;
		await session.prompt("First amendment", { source: "interactive", streamingBehavior: "steer" });
		await session.prompt("Second amendment", { source: "rpc", streamingBehavior: "steer" });
		const nextRequest = providerInputs.length;
		release();
		await running;
		await session.waitForIdle();
		const goal = await readGoal(goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager }));
		expect(goal).toMatchObject({
			objective: "Original command objective",
			amendments: ["First amendment", "Second amendment"],
			status: "complete",
		});
		expect(versions[nextRequest]).toEqual([{ goalId: goal?.id, amendmentVersion: 2 }]);
		const providerInput = providerInputs[nextRequest];
		expect(providerInput).toContain("<objective>\\nOriginal command objective\\n</objective>");
		expect(providerInput).toContain("<amendment>\\nFirst amendment\\n</amendment>");
		expect(providerInput).toContain("<amendment>\\nSecond amendment\\n</amendment>");
		expect(test.events.all.filter((event) => event.type === "agent_start")).toHaveLength(1);
		const users = session.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []));
		expect(users).toEqual([[{ type: "text", text: "First amendment" }], [{ type: "text", text: "Second amendment" }]]);
		expect(test.events.toolCalls.some((call) => call.toolName === "create_goal")).toBe(false);
		expect(test.events.toolResults.every((result) => !result.isError)).toBe(true);
	});

	it("rejects an old provider completion after steer acceptance, then completes current scope", async () => {
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let requests = 0;
		let afterStale: Awaited<ReturnType<typeof readGoal>> = null;
		test = await createTestSession({
			extensions: [GOAL_EXTENSION],
			fauxResponseRouter: async () => {
				if (++requests === 1) {
					entered();
					await gate;
				} else if (requests === 2) afterStale = await readGoal(ref);
				return undefined;
			},
		});
		const session: AgentSession = test.session;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		const running = test.run(
			when("/goal Original provider scope", [
				calls("update_goal", { status: "complete" }),
				calls("update_goal", { status: "complete" }),
				says("Finished current scope"),
			]),
		);
		await waiting;
		await session.prompt("New scope while provider is in flight", {
			source: "interactive",
			streamingBehavior: "steer",
		});
		release();
		await running;
		await session.waitForIdle();
		const results = test.events.toolResultsFor("update_goal");
		expect(results).toHaveLength(2);
		expect(results[0]?.isError).toBe(true);
		expect(results[1]?.isError).toBe(false);
		expect(afterStale).toMatchObject({ status: "active", amendments: ["New scope while provider is in flight"] });
		expect(await readGoal(ref)).toMatchObject({
			status: "complete",
			amendments: ["New scope while provider is in flight"],
		});
		expect(test.events.all.filter((event) => event.type === "agent_start")).toHaveLength(1);
	});

	it.each(["clear", "Replacement"])("never rebinds accepted steer after /goal %s", async (command) => {
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		test = await createTestSession({
			extensions: [GOAL_EXTENSION],
			extensionFactories: [waitTool(entered)],
			mockUI: { select: "Replace current goal" },
		});
		const session: AgentSession = test.session;
		await session.prompt("/goal");
		const initial = test.run(when("Start work", [calls("create_goal", { objective: "Original" }), calls("goal_wait")]));
		await waiting;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		await session.prompt("Owned by original", { source: "rpc", streamingBehavior: "steer" });
		const accepted = await readGoal(ref);
		expect(accepted?.amendments).toEqual(["Owned by original"]);
		await session.prompt(`/goal ${command}`);
		await session.abort();
		await initial;
		const current = await readGoal(ref);
		if (command === "clear") expect(current).toBeNull();
		else {
			expect(current).toMatchObject({ objective: "Replacement", status: "active" });
			expect(current?.id).not.toBe(accepted?.id);
			expect(current?.amendments).toBeUndefined();
		}
	});

	it("supplies only budget-limited context on exhausted confirmed resume", async () => {
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const contexts: string[] = [];
		test = await createTestSession({
			extensions: [GOAL_EXTENSION],
			extensionFactories: [
				waitTool(entered),
				(pi: ExtensionAPI) => {
					pi.on("context", (event) => {
						contexts.push(JSON.stringify(event.messages));
					});
				},
			],
			mockUI: { select: "Continue existing goal" },
		});
		const session: AgentSession = test.session;
		await session.prompt("/goal");
		const initial = test.run(
			when("Start budgeted work", [
				calls("create_goal", { objective: "Original", token_budget: 1 }),
				calls("goal_wait"),
			]),
		);
		await waiting;
		await session.abort();
		await initial;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		// Native faux usage is enough to exhaust the one-token budget.
		expect((await readGoal(ref))?.tokensUsed).toBeGreaterThanOrEqual(1);
		await test.run(when("One more requirement", [says("Budget report only")]));
		expect(await readGoal(ref)).toMatchObject({
			status: "budgetLimited",
			tokenBudget: 1,
			amendments: ["One more requirement"],
		});
		expect(contexts.at(-1)).toContain("pi-goal-budget-limit");
		expect(contexts.at(-1)).not.toContain("pi-goal-continuation");
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-budget-limit"),
		).toHaveLength(1);
	});

	it.each(["text", "template", "skill"])("preserves native %s expansion, images and user history", async (kind) => {
		const cwd = resolve(agentDir, "project");
		mkdirSync(resolve(cwd, ".pi/prompts"), { recursive: true });
		mkdirSync(resolve(cwd, ".pi/skills/fixture"), { recursive: true });
		writeFileSync(resolve(cwd, ".pi/prompts/fixture.md"), "Template native expansion: $ARGUMENTS");
		writeFileSync(
			resolve(cwd, ".pi/skills/fixture/SKILL.md"),
			"---\nname: fixture\ndescription: Native expansion fixture\n---\nSkill native expansion",
		);
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		test = await createTestSession({
			cwd,
			extensions: [GOAL_EXTENSION],
			extensionFactories: [waitTool(entered, gate)],
		});
		const session: AgentSession = test.session;
		await session.prompt("/goal");
		const running = test.run(
			when("Start work", [
				calls("create_goal", { objective: "Original" }),
				calls("goal_wait"),
				calls("update_goal", { status: "complete" }),
				says("Done"),
			]),
		);
		await waiting;
		const text =
			kind === "text"
				? "  Native user amendment  "
				: kind === "template"
					? "/fixture supplied argument"
					: "/skill:fixture supplied argument";
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		await session.prompt(text, { source: "rpc", streamingBehavior: "steer", images: [image] });
		const ref = goalStoreRef({ cwd, sessionManager: session.sessionManager });
		expect((await readGoal(ref))?.amendments).toEqual(kind === "text" ? [text] : undefined);
		release();
		await running;
		const users = session.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
		expect(users).toHaveLength(2);
		expect(users[1]?.content).toEqual(expect.arrayContaining([image]));
		expect(JSON.stringify(users[1]?.content)).toContain(
			kind === "text"
				? text
				: kind === "template"
					? "Template native expansion: supplied argument"
					: "Skill native expansion",
		);
		expect(test.events.all.filter((event) => event.type === "agent_start")).toHaveLength(1);
		expect(test.events.toolResults.every((result) => !result.isError)).toBe(true);
	});

	it("excludes native extension-origin steer and user followUp from amendments", async () => {
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		test = await createTestSession({ extensions: [GOAL_EXTENSION], extensionFactories: [waitTool(entered)] });
		const session: AgentSession = test.session;
		await session.prompt("/goal");
		const running = test.run(when("Start work", [calls("create_goal", { objective: "Original" }), calls("goal_wait")]));
		await waiting;
		await session.prompt("Extension-origin steer", { source: "extension", streamingBehavior: "steer" });
		await session.prompt("User followUp", { source: "interactive", streamingBehavior: "followUp" });
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		expect((await readGoal(ref))?.amendments).toBeUndefined();
		expect(test.events.ui.filter((call) => call.method === "select")).toHaveLength(0);
		await session.abort();
		await running;
		expect((await readGoal(ref))?.cancellationOffer).toEqual(expect.any(String));
	});

	it("ignores stale native confirmation after clear while processing the original input once", async () => {
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		test = await createTestSession({ extensions: [GOAL_EXTENSION], extensionFactories: [waitTool(entered)] });
		const session: AgentSession = test.session;
		await session.prompt("/goal");
		const running = test.run(when("Start work", [calls("create_goal", { objective: "Original" }), calls("goal_wait")]));
		await waiting;
		await session.abort();
		await running;
		let opened: () => void = () => {};
		const dialog = new Promise<void>((resolve) => {
			opened = resolve;
		});
		let answer: (choice: string) => void = () => {};
		const ui: ExtensionUIContext = createMockUIContext({}, test.events.ui);
		ui.select = async () => {
			opened();
			return new Promise<string>((resolve) => {
				answer = resolve;
			});
		};
		await session.bindExtensions({ uiContext: ui });
		const original = test.run(when("Original message during dialog", [says("Ordinary answer")]));
		await dialog;
		await session.prompt("/goal clear");
		answer("Continue existing goal");
		await original;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		expect(await readGoal(ref)).toBeNull();
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "pi-goal-input-decision"),
		).toMatchObject([{ data: { decision: "stale", amendmentVersion: 0 } }]);
		expect(
			session.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes("Original message during dialog"),
				),
		).toHaveLength(1);
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-continuation"),
		).toHaveLength(0);
	});

	it("continues once at the native boundary and round-trips the blocked reason", async () => {
		test = await createTestSession({ extensions: [GOAL_EXTENSION] });
		await test.session.prompt("/goal");
		await test.run(
			when("Explicitly create a Goal and pursue it.", [
				calls("create_goal", { objective: "Obtain external approval" }),
				says("Available work done; checking external state."),
				calls("update_goal", {
					status: "blocked",
					blockedReason: "  Approval service unavailable after exhausted paths  ",
				}),
				calls("get_goal", {}),
				says("Blocked on external approval."),
			]),
		);
		await test.session.waitForIdle();
		const nativeSession: AgentSession = test.session;
		expect(
			nativeSession.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-continuation"),
		).toHaveLength(1);
		const result = test.events.toolResultsFor("get_goal")[0];
		expect(JSON.parse(result?.text ?? "null").goal).toMatchObject({
			status: "blocked",
			blockedReason: "Approval service unavailable after exhausted paths",
			blockedAt: expect.any(Number),
		});
		expect(test.events.toolResults.every((result) => !result.isError)).toBe(true);
		await test.session.prompt("/goal");
		expect(
			test.events.ui.some(
				(call) => call.method === "notify" && String(call.args[0]).includes("Blocked: Approval service unavailable"),
			),
		).toBe(true);
	});

	it("accounts the hard budget and emits one native wrapup without substantive continuation", async () => {
		let requests = 0;
		test = await createTestSession({
			extensions: [GOAL_EXTENSION],
			fauxResponseRouter: () => {
				if (++requests !== 2) return undefined;
				const message = fauxAssistantMessage([fauxText("Work consumed the budget.")], { stopReason: "stop" });
				message.usage.input = 5;
				message.usage.output = 2;
				message.usage.totalTokens = 7;
				return message;
			},
		});
		await test.session.prompt("/goal");
		await test.run(
			when("Explicitly create a budgeted Goal.", [
				calls("create_goal", { objective: "Budgeted work", token_budget: 1 }),
				says("Usage report; no more work."),
			]),
		);
		const session: AgentSession = test.session;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		const firstEnd = test.events.all.find((event) => event.type === "agent_end");
		if (firstEnd?.type !== "agent_end") throw new Error("Missing native accounting event");
		const consumed = firstEnd.messages.reduce(
			(total, message) => total + (message.role === "assistant" ? message.usage.input + message.usage.output : 0),
			0,
		);
		expect(consumed).toBeGreaterThanOrEqual(7);
		expect(await readGoal(ref)).toMatchObject({ status: "budgetLimited", tokensUsed: consumed });
		expect(requests).toBe(3);
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-budget-limit"),
		).toHaveLength(1);
	});

	it.each(["error", "aborted"] as const)("distinguishes provider %s from user Stop", async (outcome) => {
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let requests = 0;
		test = await createTestSession({
			extensions: [GOAL_EXTENSION],
			fauxResponseRouter: async (_context, options) => {
				if (++requests === 1) return undefined;
				entered();
				if (outcome === "aborted")
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) resolve();
						else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
				return fauxAssistantMessage([], { stopReason: outcome, errorMessage: "Fixture provider outcome" });
			},
		});
		const session: AgentSession = test.session;
		await session.prompt("/goal");
		const running = test.run(
			when("Create a Goal before the provider request.", [calls("create_goal", { objective: "Provider work" })]),
		);
		await waiting;
		if (outcome === "aborted") await session.abort();
		await running;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		expect(await readGoal(ref)).toMatchObject({ status: outcome === "aborted" ? "paused" : "active" });
		if (outcome === "error") expect((await readGoal(ref))?.cancellationOffer).toBeUndefined();
		else expect((await readGoal(ref))?.cancellationOffer).toEqual(expect.any(String));
		expect(requests).toBe(2);
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-continuation"),
		).toHaveLength(0);
	});

	it("persists in-flight tool abort across rebind and ordinary input until explicit resume", async () => {
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		test = await createTestSession({
			extensions: [GOAL_EXTENSION],
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerTool({
						name: "goal_wait",
						label: "Wait",
						description: "Cancellation fixture",
						parameters: Type.Object({}),
						async execute(_id, _params, signal) {
							entered();
							await new Promise<void>((resolve) => {
								if (signal?.aborted) resolve();
								else signal?.addEventListener("abort", () => resolve(), { once: true });
							});
							return { content: [{ type: "text", text: "Cancelled wait" }], details: {} };
						},
					});
				},
			],
		});
		const session: AgentSession = test.session;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		await session.prompt("/goal");
		const running = test.run(
			when("Create a goal and wait for the external tool.", [
				calls("create_goal", { objective: "Finish cancellable work" }),
				calls("goal_wait", {}),
			]),
		);
		await waiting;
		await session.abort();
		await running;
		expect(await readGoal(ref)).toMatchObject({ status: "paused" });
		await session.bindExtensions({});
		await test.run(when("An ordinary unrelated question.", [calls("get_goal", {}), says("Still paused.")]));
		expect(await readGoal(ref)).toMatchObject({ status: "paused" });
		expect(test.events.messages.filter((message) => message.role === "custom")).toHaveLength(0);
		await test.run(
			when("/goal resume", [calls("update_goal", { status: "complete" }), says("Finished after explicit resume.")]),
		);
		await session.waitForIdle();
		expect(await readGoal(ref)).toMatchObject({ status: "complete" });
		expect(test.events.all.some((event) => event.type === "agent_settled")).toBe(true);
	});
});
