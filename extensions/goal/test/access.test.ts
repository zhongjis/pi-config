import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { GOAL_ACCESS_ENTRY, GOAL_TOOL_NAMES, GOAL_TOOL_OWNER_CHANNEL, goalToolAccess, modesOwnGoalTools } from "../src/goal/access.js";
import { goalStoreRef } from "../src/goal/context.js";
import { createGoal, goalFilePath, updateGoal } from "../src/goal/store.js";
import { GOAL_STATUS_VALUES } from "../src/goal/types.js";
import goalExtension from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function context() {
	const dir = await mkdtemp(join(tmpdir(), "goal-access-"));
	dirs.push(dir);
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const ctx = createMockContext();
	ctx.sessionManager.getSessionDir = () => dir;
	ctx.sessionManager.getSessionFile = () => join(dir, "session.jsonl");
	return { ...ctx, sessionManager: { ...ctx.sessionManager, getEntries: () => entries }, entries };
}

describe("Goal-owned tool access", () => {
	it("requires session-matching activation, never inherited access", async () => {
		const ctx = await context();
		expect(await goalToolAccess(ctx as never)).toEqual([]);
		ctx.entries.push({ type: "custom", customType: GOAL_ACCESS_ENTRY, data: { sessionId: "other" } });
		expect(await goalToolAccess(ctx as never)).toEqual([]);
		ctx.entries.push({ type: "custom", customType: GOAL_ACCESS_ENTRY, data: { sessionId: ctx.sessionManager.getSessionId() } });
		expect(await goalToolAccess(ctx as never)).toEqual(GOAL_TOOL_NAMES);
	});
	it.each(GOAL_STATUS_VALUES)("restores %s without changing lifecycle", async (status) => {
		const ctx = await context();
		const ref = goalStoreRef(ctx);
		await createGoal(ref, "Fixture");
		await updateGoal(ref, { status, ...(status === "blocked" ? { blockedReason: "Fixture blocker" } : {}) });
		expect(await goalToolAccess(ctx as never)).toEqual(status === "complete" ? [] : ["get_goal", "update_goal"]);
	});
	it("propagates lookup errors rather than inventing fresh state", async () => {
		const ctx = await context();
		const ref = goalStoreRef(ctx);
		await createGoal(ref, "Fixture");
		await writeFile(goalFilePath(ref), "invalid");
		await expect(goalToolAccess(ctx as never)).rejects.toThrow();
	});
	it("discovers the live tool owner without retaining reply listeners", () => {
		const mock = createMockPi();
		expect(modesOwnGoalTools(mock.pi as never)).toBe(false);
		mock.pi.events.on(GOAL_TOOL_OWNER_CHANNEL, (request) => {
			if (typeof request !== "object" || request === null || !("requestId" in request)) throw new Error("Invalid request");
			mock.pi.events.emit(`${GOAL_TOOL_OWNER_CHANNEL}:reply:${request.requestId}`, { success: true, data: true });
		});
		expect(modesOwnGoalTools(mock.pi as never)).toBe(true);
	});
	it("consumes repeated activation once and clears pending on session switching", async () => {
		const ctx = await context();
		const mock = createMockPi();
		goalExtension({ ...mock.pi, appendEntry(customType: string, data: unknown) {
			ctx.entries.push({ type: "custom", customType, data });
		} } as never);
		await mock.fireLifecycle("session_start", {}, ctx);
		const signal = { sessionId: ctx.sessionManager.getSessionId() };
		mock.pi.events.emit("ulw:activated", { sessionId: "other" });
		expect(ctx.entries).toHaveLength(0);
		mock.pi.events.emit("ulw:activated", signal);
		mock.pi.events.emit("ulw:activated", signal);
		const fireBeforeStart = mock.lifecycleHandlers.get("before_agent_start")![0];
		const bootstrap = await fireBeforeStart({}, ctx) as { message: { customType: string; details: unknown } };
		expect(bootstrap).toMatchObject({ message: { customType: "pi-goal-bootstrap", display: false } });
		const messages = [{ role: "custom", ...bootstrap.message }];
		const contextHook = mock.lifecycleHandlers.get("context")![0];
		expect(await contextHook({ messages }, ctx)).toEqual({ messages });
		expect(await fireBeforeStart({}, ctx)).toBeUndefined();
		expect(await contextHook({ messages }, ctx)).toEqual({ messages: [] });
		mock.pi.events.emit("ulw:activated", signal);
		await mock.fireLifecycle("session_before_switch", {}, await context());
		expect(await fireBeforeStart({}, ctx)).toBeUndefined();
	});
});
