import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createGoalAdmission } from "../src/goal/continuation.js";
import { goalStoreRef } from "../src/goal/context.js";
import { createGoal, updateGoal } from "../src/goal/store.js";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "goal-admission-"));
	dirs.push(dir);
	const ctx = {
		cwd: dir,
		signal: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionFile: () => join(dir, "session.jsonl"),
			getSessionDir: () => dir,
			getSessionId: () => "session",
		},
	} as unknown as ExtensionContext;
	const ref = goalStoreRef(ctx);
	const goal = await createGoal(ref, "Verify everything");
	return { ctx, ref, goal, admission: createGoalAdmission() };
}

describe("Goal admission", () => {
	it("admits one candidate across simultaneous callers and resets at a new run", async () => {
		const { ctx, goal, admission } = await fixture();
		const drafts = await Promise.all([admission.admit(ctx, goal), admission.admit(ctx, goal)]);
		expect(drafts.filter(Boolean)).toHaveLength(1);
		admission.started();
		expect(await admission.admit(ctx, goal, true)).toMatchObject({ customType: "pi-goal-continuation" });
	});
	it("invalidates awaited candidates on controls, session changes and shutdown", async () => {
		const { ctx, goal, admission } = await fixture();
		const pending = admission.admit(ctx, goal);
		admission.invalidate();
		expect(await pending).toBeUndefined();
		expect(await admission.admit(ctx, goal)).toBeDefined();
	});
	it("rejects a replaced or paused identity", async () => {
		const { ctx, ref, goal, admission } = await fixture();
		await updateGoal(ref, { status: "paused" });
		expect(await admission.admit(ctx, goal)).toBeUndefined();
		await updateGoal(ref, { objective: "Replacement" });
		expect(await admission.admit(ctx, goal)).toBeUndefined();
	});
	it("rechecks pending work and idle state and permits later admission", async () => {
		const { ctx, goal, admission } = await fixture();
		const pending = admission.admit(ctx, goal);
		ctx.hasPendingMessages = () => true;
		expect(await pending).toBeUndefined();
		ctx.hasPendingMessages = () => false;
		ctx.isIdle = () => false;
		expect(await admission.admit(ctx, goal)).toBeUndefined();
		expect(await admission.admit(ctx, goal, true)).toBeDefined();
	});
	it("admits only one budget wrapup and never an idle budget continuation", async () => {
		const { ctx, ref, goal, admission } = await fixture();
		const limited = await updateGoal(ref, { status: "budgetLimited" });
		expect(await admission.admit(ctx, limited)).toBeUndefined();
		expect(await admission.admit(ctx, limited, true)).toMatchObject({ customType: "pi-goal-budget-limit" });
		admission.committed(limited);
		admission.started();
		expect(await admission.admit(ctx, limited, true)).toBeUndefined();
		expect(await admission.admit(ctx, goal, true)).toBeUndefined();
	});
});
