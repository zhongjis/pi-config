import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goalStoreRef, readGoalForContext } from "../src/goal/context.js";
import { createGoal, goalFilePath, updateGoal } from "../src/goal/store.js";
import { GOAL_STATUS_VALUES } from "../src/goal/types.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function context() {
  const dir = await mkdtemp(join(tmpdir(), "goal-context-"));
  dirs.push(dir);
  return { cwd: "/project", sessionManager: {
    getSessionId: () => "thread", getSessionDir: () => dir,
    getSessionFile: (): string | undefined => join(dir, "thread.jsonl"),
  } };
}

describe("shared Goal context reader", () => {
  it("uses the session directory and returns null only when absent", async () => {
    const ctx = await context();
    expect(goalStoreRef(ctx)).toEqual({ baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"), threadId: "thread" });
    expect(await readGoalForContext(ctx)).toBeNull();
    const goal = await createGoal(goalStoreRef(ctx), "Work");
    expect(await readGoalForContext(ctx)).toEqual(goal);
    await writeFile(goalFilePath(goalStoreRef(ctx)), "broken json");
    await expect(readGoalForContext(ctx)).rejects.toThrow();
  });

  it.each(GOAL_STATUS_VALUES)("returns existing %s records without granting task continuation", async (status) => {
    const ctx = await context();
    const ref = goalStoreRef(ctx);
    await createGoal(ref, "Work");
    await updateGoal(ref, { status });
    expect((await readGoalForContext(ctx))?.status).toBe(status);
  });

  it("keeps no-session storage isolated by cwd and respects agent directory overrides", async () => {
    const ctx = await context();
    ctx.sessionManager.getSessionFile = () => undefined;
    vi.stubEnv("PI_CODING_AGENT_DIR", ctx.sessionManager.getSessionDir());
    const ref = goalStoreRef(ctx);
    expect(ref.baseDir.startsWith(join(ctx.sessionManager.getSessionDir(), "extensions", "goal", "no-session"))).toBe(true);
    await createGoal(ref, "Work");
    expect((await readGoalForContext(ctx))?.objective).toBe("Work");
    expect(await readGoalForContext({ ...ctx, cwd: "/other" })).toBeNull();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    expect(goalStoreRef(ctx).baseDir.startsWith(join(homedir(), ".pi", "agent", "extensions", "goal", "no-session"))).toBe(true);
  });
});
