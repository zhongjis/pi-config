import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { goalStoreRef } from "../src/goal/context.js";
import { createGoal } from "../src/goal/store.js";
import piGoalExtension from "../src/index.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "goal-bg-"));
	dirs.push(dir);
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, Handler[]>();
	const noop = () => {};
	const pi = new Proxy(
		{
			getActiveTools: () => [],
			getAllTools: () => [],
			on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
			events: { on: (name: string, h: Handler) => bus.set(name, [...(bus.get(name) ?? []), h]), emit: noop },
		},
		{ get: (target, key) => (key in target ? target[key as keyof typeof target] : noop) },
	) as unknown as ExtensionAPI;
	piGoalExtension(pi);
	const ctx = {
		cwd: dir,
		hasUI: false,
		signal: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionFile: () => join(dir, "s.jsonl"), getSessionDir: () => dir, getSessionId: () => "s" },
	};
	await createGoal(goalStoreRef(ctx as never), "Verify everything");
	const fire = async (name: string, event: unknown) => {
		let result: unknown;
		for (const h of handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
		return result;
	};
	const settle = () => fire("agent_before_settle", { outcome: "completed", continue: false });
	const bgRun = (task: Record<string, unknown>) =>
		fire("tool_result", { toolName: "bg_run", isError: false, details: { task } });
	const terminal = async (id: string) => {
		for (const h of bus.get("pi-background-tasks:terminal:v1") ?? []) await h({ task: { id } }, ctx);
	};
	return { settle, bgRun, terminal, fire };
}
const running = { id: "t1", status: "running", notifyOnCompletion: true, triggerOnCompletion: true };

describe("Goal continuation with background tasks", () => {
	it("waits while a waking bg task is open and resumes after its terminal event", async () => {
		const { settle, bgRun, terminal } = await fixture();
		await bgRun(running);
		expect(await settle()).toBeUndefined();
		await terminal("t1");
		expect(await settle()).toMatchObject({ continue: true });
	});
	it("does not track tasks that will not wake the agent", async () => {
		const { settle, bgRun } = await fixture();
		await bgRun({ ...running, triggerOnCompletion: false });
		expect(await settle()).toMatchObject({ continue: true });
	});
	it("ignores a task whose terminal event arrived first and clears on session_start", async () => {
		const f = await fixture();
		await f.terminal("t1");
		await f.bgRun(running);
		expect(await f.settle()).toMatchObject({ continue: true });
		await f.bgRun({ ...running, id: "t2" });
		await f.fire("session_start", {});
		await f.fire("agent_start", {});
		expect(await f.settle()).toMatchObject({ continue: true });
	});
});
