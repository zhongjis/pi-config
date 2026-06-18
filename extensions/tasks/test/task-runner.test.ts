/**
 * Tests for the TaskRunner seam (task-runner.ts).
 *
 * The headline win of the seam: TaskOutput / TaskStop can be exercised through
 * a fake subagent bridge + in-memory store, with no real subagent spawned.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentBridge } from "../src/bridge/subagent-bridge.js";
import { createTaskRuntime, type TaskRuntime } from "../src/lifecycle/store-glue.js";
import { createTaskRunner } from "../src/task-runner.js";

type Handler = (data: unknown) => void;

/** Minimal ExtensionAPI mock exposing a synchronous event bus. */
function mockPi() {
  const handlers = new Map<string, Handler[]>();
  const events = {
    on(channel: string, handler: Handler) {
      const arr = handlers.get(channel) ?? [];
      arr.push(handler);
      handlers.set(channel, arr);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter(h => h !== handler));
    },
    emit(channel: string, data: unknown) {
      for (const h of [...(handlers.get(channel) ?? [])]) h(data);
    },
  };
  return { events } as unknown as ExtensionAPI;
}

/** Fake bridge — only stopSubagent is used by the runner. */
function fakeBridge() {
  return { stopSubagent: vi.fn().mockResolvedValue(undefined) } as unknown as SubagentBridge & { stopSubagent: ReturnType<typeof vi.fn> };
}

/** Seed an in-progress subagent-backed task; returns its task id. */
function seedSubagentTask(runtime: TaskRuntime, agentId = "agent-1"): string {
  const task = runtime.store.create("Agent task", "Desc", undefined, { agentType: "general-purpose", agentId });
  runtime.store.update(task.id, { status: "in_progress" });
  runtime.agentTaskMap.set(agentId, task.id);
  return task.id;
}

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; vi.restoreAllMocks(); });

describe("TaskRunner — subagent adapter", () => {
  it("returns a subagent status line without spawning", async () => {
    const runtime = createTaskRuntime();
    const id = seedSubagentTask(runtime);
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    const out = await runner.getOutput(id, { block: false, timeout: 1000 });
    expect(out).toBe(`Task #${id} [in_progress] — subagent agent-1`);
  });

  it("resolves a bound agent id back to its task", async () => {
    const runtime = createTaskRuntime();
    seedSubagentTask(runtime, "agent-1");
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    const out = await runner.getOutput("agent-1", { block: false, timeout: 1000 });
    expect(out).toContain("subagent agent-1");
  });

  it("throws 'No task found' for an unknown id", async () => {
    const runtime = createTaskRuntime();
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    await expect(runner.getOutput("999", { block: false, timeout: 1000 })).rejects.toThrow("No task found with ID 999");
  });

  it("blocks until subagents:completed then resolves", async () => {
    const runtime = createTaskRuntime();
    const id = seedSubagentTask(runtime);
    const pi = mockPi();
    const runner = createTaskRunner(pi, runtime, fakeBridge());

    const pending = runner.getOutput(id, { block: true, timeout: 30000 });
    // Listeners are registered synchronously before the promise is returned.
    runtime.store.update(id, { status: "completed" });
    pi.events.emit("subagents:completed", { id: "agent-1" });

    expect(await pending).toBe(`Task #${id} [completed] — subagent agent-1`);
  });

  it("stop marks the task completed and stops the subagent", async () => {
    const runtime = createTaskRuntime();
    const id = seedSubagentTask(runtime);
    const bridge = fakeBridge();
    const runner = createTaskRunner(mockPi(), runtime, bridge);

    const msg = await runner.stop(id);
    expect(msg).toBe(`Task #${id} stopped successfully`);
    expect(bridge.stopSubagent).toHaveBeenCalledWith("agent-1");
    expect(runtime.store.get(id)?.status).toBe("completed");
  });

  it("throws when nothing is running", async () => {
    const runtime = createTaskRuntime();
    runtime.store.create("Manual", "Desc"); // pending, no agentId, no process
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    await expect(runner.stop("1")).rejects.toThrow("No running background process for task 1");
  });
});

describe("TaskRunner — process adapter", () => {
  it("returns buffered process output through the seam", async () => {
    const runtime = createTaskRuntime();
    const proc = spawn("echo", ["hello from process"]);
    runtime.tracker.track("1", proc, "echo");
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    const out = await runner.getOutput("1", { block: true, timeout: 5000 });
    expect(out).toContain("hello from process");
    expect(out).toContain("(completed)");
  });
});

describe("TaskRunner — subagent read paths (Fix A + edge cases)", () => {
  function seedTerminal(
    runtime: TaskRuntime,
    status: "completed" | "pending",
    extraMeta: Record<string, unknown>,
    agentId = "agent-1",
  ): string {
    const t = runtime.store.create("Agent task", "Desc", undefined, { agentType: "general-purpose", agentId, ...extraMeta });
    runtime.store.update(t.id, { status });
    runtime.agentTaskMap.set(agentId, t.id);
    return t.id;
  }

  it("F1: appends metadata.result for a completed subagent task", async () => {
    const runtime = createTaskRuntime();
    const id = seedTerminal(runtime, "completed", { result: "THE REAL OUTPUT" });
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    const out = await runner.getOutput(id, { block: false, timeout: 1000 });
    expect(out).toContain("[completed]");
    expect(out).toContain("THE REAL OUTPUT");
  });

  it("F1: appends lastError for a failed/requeued subagent task", async () => {
    const runtime = createTaskRuntime();
    const id = seedTerminal(runtime, "pending", { lastError: "out of turns" });
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    const out = await runner.getOutput(id, { block: false, timeout: 1000 });
    expect(out).toContain("Error: out of turns");
  });

  it("F5: an agent-id input resolves to the task and surfaces its result", async () => {
    const runtime = createTaskRuntime();
    seedTerminal(runtime, "completed", { result: "RESOLVED VIA AGENT ID" }, "agent-7");
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    const out = await runner.getOutput("agent-7", { block: false, timeout: 1000 });
    expect(out).toContain("RESOLVED VIA AGENT ID");
  });

  it("block resolves when subagents:failed fires", async () => {
    const runtime = createTaskRuntime();
    const id = seedSubagentTask(runtime);
    const pi = mockPi();
    const runner = createTaskRunner(pi, runtime, fakeBridge());

    const pending = runner.getOutput(id, { block: true, timeout: 30000 });
    runtime.store.update(id, { status: "pending", metadata: { agentType: "general-purpose", agentId: "agent-1", lastError: "boom" } });
    pi.events.emit("subagents:failed", { id: "agent-1" });

    const out = await pending;
    expect(out).toContain("[pending]");
    expect(out).toContain("Error: boom");
  });

  it("block resolves on timeout when no event arrives", async () => {
    const runtime = createTaskRuntime();
    const id = seedSubagentTask(runtime);
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    const out = await runner.getOutput(id, { block: true, timeout: 30 });
    expect(out).toBe(`Task #${id} [in_progress] — subagent agent-1`);
  });

  it("block resolves when the abort signal fires", async () => {
    const runtime = createTaskRuntime();
    const id = seedSubagentTask(runtime);
    const controller = new AbortController();
    const runner = createTaskRunner(mockPi(), runtime, fakeBridge());

    const pending = runner.getOutput(id, { block: true, timeout: 30000, signal: controller.signal });
    controller.abort();

    const out = await pending;
    expect(out).toContain("[in_progress]");
  });
});
