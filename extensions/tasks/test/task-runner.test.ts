import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskRuntime } from "../src/lifecycle/store-glue.js";
import { createTaskRunner } from "../src/task-runner.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; vi.restoreAllMocks(); });

describe("TaskRunner — process-only", () => {
  it("returns buffered process output", async () => {
    const runtime = createTaskRuntime();
    const proc = spawn("echo", ["hello from process"]);
    runtime.tracker.track("1", proc, "echo");
    const runner = createTaskRunner(runtime);

    const out = await runner.getOutput("1", { block: true, timeout: 5000 });
    expect(out).toContain("hello from process");
    expect(out).toContain("(completed)");
  });

  it("distinguishes an untracked task from an unknown task", async () => {
    const runtime = createTaskRuntime();
    runtime.store.create("Manual", "Desc");
    const runner = createTaskRunner(runtime);

    await expect(runner.getOutput("1", { block: false, timeout: 1000 })).rejects.toThrow("No background process for task 1");
    await expect(runner.getOutput("999", { block: false, timeout: 1000 })).rejects.toThrow("No task found with ID 999");
  });

  it("stops a tracked process and completes its task", async () => {
    const runtime = createTaskRuntime();
    runtime.store.create("Long process", "Desc");
    runtime.store.update("1", { status: "in_progress" });
    const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    runtime.tracker.track("1", proc, "node");
    const runner = createTaskRunner(runtime);

    await expect(runner.stop("1")).resolves.toBe("Task #1 stopped successfully");
    expect(runtime.store.get("1")?.status).toBe("completed");
  });

  it("rejects stop when no process is running", async () => {
    const runtime = createTaskRuntime();
    runtime.store.create("Manual", "Desc");
    const runner = createTaskRunner(runtime);

    await expect(runner.stop("1")).rejects.toThrow("No running background process for task 1");
  });
});
