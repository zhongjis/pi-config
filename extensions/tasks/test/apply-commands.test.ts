/**
 * Unit tests for the apply layer. `runSpawn` is the shared spawn primitive used
 * by both the cascade applier and the TaskExecute tool; these pin its bind
 * (success) and revert-to-pending-with-lastError (failure) behavior — the latter
 * was previously exercised only indirectly. `applyCommands` is spot-checked for
 * faithful per-command dispatch.
 */

import { describe, expect, it, vi } from "vitest";
import { applyCommands, runSpawn } from "../src/lifecycle/apply-commands.js";
import type { TaskRuntime } from "../src/lifecycle/store-glue.js";
import { TaskStore } from "../src/task-store.js";

function makeRuntime(store: TaskStore) {
  return {
    store,
    agentTaskMap: new Map<string, string>(),
    widget: { setActiveTask: vi.fn(), update: vi.fn() },
    autoClear: { trackCompletion: vi.fn(), resetBatchCountdown: vi.fn() },
    currentTurn: 7,
  } as unknown as TaskRuntime;
}

function makeBridge() {
  return { spawnSubagent: vi.fn(), buildTaskPrompt: vi.fn().mockReturnValue("PROMPT") };
}

describe("runSpawn", () => {
  it("binds the task on spawn success", async () => {
    const store = new TaskStore();
    store.create("Task", "desc", undefined, { agentType: "general-purpose" });
    store.update("1", { status: "in_progress" });
    const runtime = makeRuntime(store);
    const bridge = makeBridge();
    bridge.spawnSubagent.mockResolvedValue("agent-42");

    const outcome = await runSpawn(runtime, bridge as any, {
      taskId: "1",
      agentType: "general-purpose",
      additionalContext: "ctx",
      spawnOptions: { isBackground: true },
    });

    expect(outcome).toEqual({ taskId: "1", ok: true, agentId: "agent-42" });
    expect(bridge.buildTaskPrompt).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }), "ctx");
    expect(bridge.spawnSubagent).toHaveBeenCalledWith("general-purpose", "PROMPT", { isBackground: true });
    expect(runtime.agentTaskMap.get("agent-42")).toBe("1");
    const t = store.get("1")!;
    expect(t.owner).toBe("agent-42");
    expect(t.metadata.agentId).toBe("agent-42");
    expect(runtime.widget.setActiveTask).toHaveBeenCalledWith("1");
  });

  it("reverts the task to pending with lastError on spawn failure", async () => {
    const store = new TaskStore();
    store.create("Task", "desc", undefined, { agentType: "general-purpose" });
    store.update("1", { status: "in_progress" });
    const runtime = makeRuntime(store);
    const bridge = makeBridge();
    bridge.spawnSubagent.mockRejectedValue(new Error("No active session"));

    const outcome = await runSpawn(runtime, bridge as any, {
      taskId: "1",
      agentType: "general-purpose",
      spawnOptions: {},
    });

    expect(outcome).toEqual({ taskId: "1", ok: false, error: "No active session" });
    expect(runtime.agentTaskMap.size).toBe(0);
    const t = store.get("1")!;
    expect(t.status).toBe("pending");
    expect(t.metadata.lastError).toBe("No active session");
  });

  it("returns not-found without spawning when the task is gone", async () => {
    const store = new TaskStore();
    const runtime = makeRuntime(store);
    const bridge = makeBridge();

    const outcome = await runSpawn(runtime, bridge as any, { taskId: "99", agentType: "gp", spawnOptions: {} });

    expect(outcome).toEqual({ taskId: "99", ok: false, error: "task not found" });
    expect(bridge.spawnSubagent).not.toHaveBeenCalled();
  });
});

describe("applyCommands", () => {
  it("dispatches each command to its effect", async () => {
    const store = new TaskStore();
    store.create("A", "desc", undefined, { agentType: "gp" });
    store.update("1", { status: "in_progress" });
    const runtime = makeRuntime(store);
    runtime.agentTaskMap.set("agent-1", "1");
    const bridge = makeBridge();

    await applyCommands(runtime, bridge as any, [
      { kind: "deleteAgentMapping", agentId: "agent-1" },
      { kind: "updateTask", taskId: "1", fields: { status: "completed" } },
      { kind: "setActiveTask", taskId: "1", active: false },
      { kind: "trackCompletion", taskId: "1" },
      { kind: "resetBatchCountdown" },
      { kind: "widgetUpdate" },
    ]);

    expect(runtime.agentTaskMap.has("agent-1")).toBe(false);
    expect(store.get("1")!.status).toBe("completed");
    expect(runtime.widget.setActiveTask).toHaveBeenCalledWith("1", false);
    expect(runtime.autoClear.trackCompletion).toHaveBeenCalledWith("1", 7);
    expect(runtime.autoClear.resetBatchCountdown).toHaveBeenCalled();
    expect(runtime.widget.update).toHaveBeenCalled();
  });

  it("runs a spawnTask command through runSpawn", async () => {
    const store = new TaskStore();
    store.create("A", "desc", undefined, { agentType: "gp" });
    store.update("1", { status: "in_progress" });
    const runtime = makeRuntime(store);
    const bridge = makeBridge();
    bridge.spawnSubagent.mockResolvedValue("agent-7");

    await applyCommands(runtime, bridge as any, [
      { kind: "spawnTask", taskId: "1", agentType: "gp", spawnOptions: { isBackground: true } },
    ]);

    expect(runtime.agentTaskMap.get("agent-7")).toBe("1");
    expect(store.get("1")!.metadata.agentId).toBe("agent-7");
  });
});
