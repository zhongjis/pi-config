import { mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { accountGoalUsage, clearGoal, createGoal, goalFilePath, readGoal, updateGoal } from "../src/goal/store.js";
import type { GoalStoreRef } from "../src/goal/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

const tempDirs: string[] = [];

describe("goal store", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("serializes concurrent creates and every accounting delta", async () => {
		const ref = await tempStore();
		const results = await Promise.allSettled([createGoal(ref, "One"), createGoal(ref, "Two")]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		await Promise.all(
			Array.from({ length: 20 }, () =>
				accountGoalUsage(ref, { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, 1),
			),
		);
		expect(await readGoal(ref)).toMatchObject({ tokensUsed: 60, timeUsedSeconds: 20 });
		expect((await stat(goalFilePath(ref))).mode & 0o777).toBe(0o600);
	});

	it("preserves published JSON and cleans temporary files after failed rename", async () => {
		const ref = await tempStore();
		const original = await createGoal(ref, "Original");
		vi.mocked(rename).mockRejectedValueOnce(new Error("publication failed"));
		await expect(updateGoal(ref, { objective: "Replacement" })).rejects.toThrow("publication failed");
		expect(await readGoal(ref)).toEqual(original);
		expect(await readdir(ref.baseDir)).toEqual(["thread-test.json"]);
	});

	it("requires a reason, persists it, and clears metadata on resume", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Approval");
		await expect(updateGoal(ref, { status: "blocked", blockedReason: "  " })).rejects.toThrow("nonempty");
		const blocked = await updateGoal(ref, { status: "blocked", blockedReason: "  Approval unavailable  " });
		expect(blocked.blockedReason).toBe("Approval unavailable");
		expect(blocked.blockedAt).toBeTypeOf("number");
		const resumed = await updateGoal(ref, { status: "active" });
		expect(resumed.blockedReason).toBeUndefined();
		expect(resumed.blockedAt).toBeUndefined();
	});

	it("rejects stale model mutations and model changes to paused goals", async () => {
		const ref = await tempStore();
		const goal = await createGoal(ref, "Original");
		const guard = { expectedGoalId: goal.id, expectedStatus: goal.status, actor: "model" } as const;
		await updateGoal(ref, { status: "paused" });
		await expect(updateGoal(ref, { status: "complete" }, guard)).rejects.toThrow("goal changed");
		await expect(updateGoal(ref, { status: "complete" }, { ...guard, expectedStatus: "paused" })).rejects.toThrow(
			"model may only",
		);
		await updateGoal(ref, { objective: "Replacement" });
		await expect(updateGoal(ref, { status: "blocked", blockedReason: "old blocker" }, guard)).rejects.toThrow(
			"goal changed",
		);
		expect(await readGoal(ref)).toMatchObject({ objective: "Replacement", status: "active" });
	});

	it("lets explicit user pause win over a model publication already in flight", async () => {
		const ref = await tempStore();
		const goal = await createGoal(ref, "Work");
		const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const publishing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		vi.mocked(rename).mockImplementationOnce(async (...args) => {
			entered();
			await gate;
			await native.rename(...args);
		});
		const model = updateGoal(
			ref,
			{ status: "complete" },
			{ expectedGoalId: goal.id, expectedStatus: "active", actor: "model" },
		);
		await publishing;
		const pause = updateGoal(ref, { status: "paused" }, { expectedGoalId: goal.id, actor: "user" });
		release();
		await Promise.all([model, pause]);
		expect(await readGoal(ref)).toMatchObject({ status: "paused" });
	});

	it("creates a persisted active goal", async () => {
		const ref = await tempStore("thread-create");
		const goal = await createGoal(ref, "  Ship the extension  ", 10_000);

		expect(goal.threadId).toBe("thread-create");
		expect(goal.objective).toBe("Ship the extension");
		expect(goal.status).toBe("active");
		expect(goal.tokenBudget).toBe(10_000);
		expect(await readGoal(ref)).toMatchObject({ id: goal.id, objective: "Ship the extension" });
		// Normalize separators so the path assertion holds on Windows (backslashes) too.
		expect(goalFilePath(ref).replaceAll("\\", "/")).toContain("extensions/goal/thread-create.json");
		expect(goalFilePath(ref)).not.toContain(".pi");
		expect(await readFile(goalFilePath(ref), "utf8")).toContain('"version": 1');
	});

	it("does not replace an existing goal when createGoal is called again", async () => {
		const ref = await tempStore("thread-duplicate-create");
		const original = await createGoal(ref, "Original", 10_000);

		await expect(createGoal(ref, "Replacement", 20_000)).rejects.toThrow(
			"cannot create a new goal because this thread has an unfinished goal; complete the existing goal first",
		);

		expect(await readGoal(ref)).toMatchObject({
			id: original.id,
			objective: "Original",
			tokenBudget: 10_000,
		});
	});

	it("replaces changed objectives and preserves usage for status updates", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Original");
		await accountGoalUsage(ref, { input: 23, output: 2, cacheRead: 0, cacheWrite: 4, totalTokens: 25 }, 70);

		const paused = await updateGoal(ref, { status: "paused" });
		expect(paused.id).toBe(first.id);
		expect(paused.tokensUsed).toBe(25);
		expect(paused.timeUsedSeconds).toBe(70);

		const replaced = await updateGoal(ref, { objective: "Replacement" });
		expect(replaced.id).not.toBe(first.id);
		expect(replaced.tokensUsed).toBe(0);
		expect(replaced.timeUsedSeconds).toBe(0);
		expect(replaced.status).toBe("active");
	});

	it("resumes a matching nonterminal goal when the objective is set again", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Same");
		const paused = await updateGoal(ref, { status: "paused" });

		const resumed = await updateGoal(ref, { objective: "Same" });

		expect(paused.id).toBe(first.id);
		expect(resumed.id).toBe(first.id);
		expect(resumed.status).toBe("active");
	});

	it("counts Pi non-cached input plus output tokens like Codex", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Budgeted");

		const goal = await accountGoalUsage(
			ref,
			{ input: 100, output: 20, cacheRead: 70, cacheWrite: 0, totalTokens: 999 },
			0,
		);

		expect(goal).toMatchObject({ tokensUsed: 120 });
	});

	it("marks active goals budgetLimited when accounting reaches budget", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Budgeted", 50);

		const goal = await accountGoalUsage(
			ref,
			{ input: 31, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 51 },
			4,
		);

		expect(goal).toMatchObject({ status: "budgetLimited", tokensUsed: 51, timeUsedSeconds: 4 });
	});

	it("continues accounting budget-limited goals for in-flight active usage", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Budgeted", 20);
		await accountGoalUsage(ref, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 }, 7);
		await accountGoalUsage(ref, { input: 15, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, 3);

		const goal = await accountGoalUsage(
			ref,
			{ input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
			5,
			"active",
		);

		expect(goal).toMatchObject({ status: "budgetLimited", tokensUsed: 25, timeUsedSeconds: 15 });
	});

	it("keeps budget-limited goals terminal when paused or reactivated over budget", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Budgeted", 20);
		await accountGoalUsage(ref, { input: 25, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 25 }, 1);

		const paused = await updateGoal(ref, { status: "paused" });
		expect(paused).toMatchObject({ status: "budgetLimited", tokensUsed: 25, tokenBudget: 20 });

		const reactivated = await updateGoal(ref, { status: "active" });
		expect(reactivated).toMatchObject({ status: "budgetLimited", tokensUsed: 25, tokenBudget: 20 });
	});

	it("immediately budget-limits active goals when a lowered budget is already exceeded", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Budgeted", 100);
		await accountGoalUsage(ref, { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50 }, 1);

		const lowered = await updateGoal(ref, { tokenBudget: 40 });

		expect(lowered).toMatchObject({ status: "budgetLimited", tokensUsed: 50, tokenBudget: 40 });
	});

	it("finalizes paused in-flight usage without losing user pause", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Stopped", 20);
		await updateGoal(ref, { status: "paused" });

		const activeOnly = await accountGoalUsage(
			ref,
			{ input: 25, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 25 },
			3,
			"active",
		);
		expect(activeOnly).toMatchObject({ status: "paused", tokensUsed: 0, timeUsedSeconds: 0 });

		const stopped = await accountGoalUsage(
			ref,
			{ input: 25, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 25 },
			3,
			"activeOrStopped",
		);
		expect(stopped).toMatchObject({ status: "paused", tokensUsed: 25, timeUsedSeconds: 3 });
	});

	it("clears the store while preserving the versioned file", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Temporary");

		expect(await clearGoal(ref)).toBe(true);
		expect(await readGoal(ref)).toBeNull();
	});
});

async function tempStore(threadId = "thread-test"): Promise<GoalStoreRef> {
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
	tempDirs.push(dir);
	return { baseDir: join(dir, "extensions", "goal"), threadId };
}
