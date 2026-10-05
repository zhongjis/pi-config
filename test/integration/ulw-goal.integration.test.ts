import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goalStoreRef } from "../../extensions/goal/src/goal/context.js";
import { createGoal, readGoal, updateGoal } from "../../extensions/goal/src/goal/store.js";
import { calls, createTestSession, says, when, type TestSession } from "./helpers/faux-session.js";

const ulw = resolve(import.meta.dirname, "../../extensions/ulw/index.ts");
const goal = resolve(import.meta.dirname, "../../extensions/goal/index.ts");
const modes = resolve(import.meta.dirname, "../../extensions/modes/src/index.ts");
const names = ["create_goal", "get_goal", "update_goal"];

describe("ULW Goal activation in native Pi", () => {
	let test: TestSession | undefined;
	let home: string;
	let requests: string[][];
	let requestMessages: { ulw: number; bootstrap: number; bootstrapInstructions: number }[];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pi-ulw-goal-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi/agent"));
		requests = [];
		requestMessages = [];
		policy(names);
	});
	afterEach(async () => {
		await test?.session.abort();
		test?.dispose();
		test = undefined;
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});
	function policy(tools: string[]) {
		const dir = join(home, ".pi/agent/modes/kuafu");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "mode.md"), `---\nbuiltin_tools: [read]\nextension_tools: ${JSON.stringify(tools)}\n---\nSynthetic mode fixture.`);
	}
	async function start(extensions: string[]) {
		test = await createTestSession({
			extensions,
			fauxResponseRouter: (context) => {
				requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
				if (!test) throw new Error("Session missing at provider request");
				requestMessages.push({
					ulw: messages(test.session, "ultrawork").length,
					bootstrap: messages(test.session, "pi-goal-bootstrap").length,
					bootstrapInstructions: JSON.stringify(context.messages).split("<goal-bootstrap>").length - 1,
				});
				return undefined;
			},
		});
		return test;
	}
	function messages(session: AgentSession, customType: string) {
		return session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === customType);
	}

	it.each([[modes, goal, ulw], [ulw, goal, modes]])("activates before the first request in load order %j", async (...extensions) => {
		const t = await start(extensions);
		const initial: AgentSession = t.session;
		expect(initial.getActiveToolNames().filter((name) => names.includes(name))).toEqual([]);
		expect(messages(t.session, "pi-goal-bootstrap")).toHaveLength(0);
		await t.run(when("ulw research this task; proposal only", [says("Proposal.")]));
		expect(requests[0].filter((name) => names.includes(name)).sort()).toEqual([...names].sort());
		expect(requestMessages[0]).toEqual({ ulw: 1, bootstrap: 1, bootstrapInstructions: 1 });
		expect(messages(t.session, "ultrawork")).toHaveLength(1);
		expect(messages(t.session, "pi-goal-bootstrap")).toMatchObject([{ display: false }]);
		const session: AgentSession = t.session;
		expect(await readGoal(goalStoreRef({ cwd: t.cwd, sessionManager: session.sessionManager }))).toBeNull();
		await t.run(when("ordinary followup", [says("Answer.")]));
		expect(messages(session, "pi-goal-bootstrap")).toHaveLength(1);
		expect(requestMessages[1].bootstrapInstructions).toBe(0);
		await t.run(when("ulw", [says("Which task?")]));
		expect(messages(session, "ultrawork")).toHaveLength(2);
		expect(messages(session, "pi-goal-bootstrap")).toHaveLength(2);
		expect(requestMessages[2].bootstrapInstructions).toBe(1);
	});

	it("inspects, creates, and completes the agreed task after ULW activation", async () => {
		const t = await start([ulw, goal, modes]);
		await t.run(when("ulw verify the fixture output", [
			calls("get_goal", {}),
			calls("create_goal", { objective: "Verify the fixture output" }),
			calls("update_goal", { status: "complete" }),
			says("Verified."),
		]));
		for (const name of names) expect(t.events.toolResultsFor(name)).toHaveLength(1);
		expect(t.events.toolResults.every((result) => !result.isError)).toBe(true);
		const session: AgentSession = t.session;
		expect(await readGoal(goalStoreRef({ cwd: t.cwd, sessionManager: session.sessionManager })))
			.toMatchObject({ objective: "Verify the fixture output", status: "complete" });
		expect(requestMessages[0]).toEqual({ ulw: 1, bootstrap: 1, bootstrapInstructions: 1 });
	});

	it.each([[goal], [modes, goal, ulw], [ulw, goal, modes]])("activates via explicit /goal without ULW in %j", async (...extensions) => {
		const t = await start(extensions);
		await t.session.prompt("/goal");
		await t.run(when("Inspect the goal", [says("None.")]));
		expect(requests[0].filter((name) => names.includes(name)).sort()).toEqual([...names].sort());
		expect(messages(t.session, "pi-goal-bootstrap")).toHaveLength(0);
	});

	it.each([[modes, goal, ulw], [ulw, goal, modes]])("restores paused management independently of activation in %j", async (...extensions) => {
		const t = await start(extensions);
		const session: AgentSession = t.session;
		const ref = goalStoreRef({ cwd: t.cwd, sessionManager: session.sessionManager });
		await createGoal(ref, "Unfinished fixture");
		await updateGoal(ref, { status: "paused" });
		await session.bindExtensions({});
		await t.run(when("Ordinary question", [says("Still paused.")]));
		expect(requests[0].filter((name) => names.includes(name)).sort()).toEqual(["get_goal", "update_goal"]);
		expect(await readGoal(ref)).toMatchObject({ status: "paused" });
		expect(messages(session, "pi-goal-bootstrap")).toHaveLength(0);
	});

	it.each([[modes, goal, ulw], [ulw, goal, modes]])("never widens mode policy in %j", async (...extensions) => {
		policy(["get_goal"]);
		const t = await start(extensions);
		await t.session.prompt("/goal");
		await t.run(when("ulw fixture task", [says("Tools restricted.")]));
		expect(requests[0].filter((name) => names.includes(name))).toEqual(["get_goal"]);
		expect(messages(t.session, "ultrawork")).toHaveLength(1);
		expect(messages(t.session, "pi-goal-bootstrap")).toHaveLength(1);
	});

	it("retains ULW without Goal",  async () => {
		const t = await start([modes, ulw]);
		await t.run(when("ulw fixture task", [says("Done.")]));
		expect(messages(t.session, "ultrawork")).toHaveLength(1);
		expect(messages(t.session, "pi-goal-bootstrap")).toHaveLength(0);
		expect(requests[0].filter((name) => names.includes(name))).toEqual([]);
	});

	it("drops access when rebinding a fresh native session identity",  async () => {
		const t = await start([ulw, goal, modes]);
		await t.run(when("ulw fixture task", [says("Done.")]));
		const session: AgentSession = t.session;
		session.sessionManager.newSession();
		await session.bindExtensions({});
		await t.run(when("Ordinary task", [says("No activation.")]));
		expect(requests[1].filter((name) => names.includes(name))).toEqual([]);
		expect(messages(session, "ultrawork")).toHaveLength(0);
		expect(messages(session, "pi-goal-bootstrap")).toHaveLength(0);
	});
});
