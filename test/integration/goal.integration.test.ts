import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goalStoreRef } from "../../extensions/goal/src/goal/context.js";
import { readGoal } from "../../extensions/goal/src/goal/store.js";
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

	it("continues once at the native boundary and round-trips the blocked reason", async () => {
		test = await createTestSession({ extensions: [GOAL_EXTENSION] });
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
		const running = test.run(
			when("Create a Goal before the provider request.", [calls("create_goal", { objective: "Provider work" })]),
		);
		await waiting;
		if (outcome === "aborted") await session.abort();
		await running;
		const ref = goalStoreRef({ cwd: test.cwd, sessionManager: session.sessionManager });
		expect(await readGoal(ref)).toMatchObject({ status: outcome === "aborted" ? "paused" : "active" });
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
