/**
 * Unit tests for the pure DAG-advancement core. These pin the emitted command
 * ORDER (not just membership) and the three distinct `failed` sub-paths, which
 * are the behavior contract the apply layer depends on.
 */

import { describe, expect, it } from "vitest";
import {
  advanceTaskGraph,
  type CascadeConfig,
  type GraphSnapshot,
} from "../src/lifecycle/advance-task-graph.js";
import type { Task } from "../src/types.js";

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    subject: `Task ${partial.id}`,
    description: "desc",
    status: "in_progress",
    metadata: {},
    blocks: [],
    blockedBy: [],
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function snap(tasks: Task[], agentToTask: [string, string][], cascade?: CascadeConfig): GraphSnapshot {
  return { tasks, agentToTask: new Map(agentToTask), cascade };
}

describe("advanceTaskGraph — guards", () => {
  it("unknown agent → no commands (not one of ours)", () => {
    expect(advanceTaskGraph({ kind: "completed", agentId: "ghost" }, snap([], []))).toEqual([]);
  });

  it("known agent but task gone → delete mapping only", () => {
    expect(advanceTaskGraph({ kind: "completed", agentId: "a1" }, snap([], [["a1", "1"]]))).toEqual([
      { kind: "deleteAgentMapping", agentId: "a1" },
    ]);
  });
});

describe("advanceTaskGraph — completed", () => {
  it("no cascade → finalize, deactivate, track, render", () => {
    const t1 = task({ id: "1", status: "in_progress", metadata: { agentType: "gp" } });
    const cmds = advanceTaskGraph({ kind: "completed", agentId: "a1", result: "done" }, snap([t1], [["a1", "1"]]));
    expect(cmds).toEqual([
      { kind: "deleteAgentMapping", agentId: "a1" },
      { kind: "updateTask", taskId: "1", fields: { status: "completed", metadata: { agentType: "gp", result: "done" } } },
      { kind: "setActiveTask", taskId: "1", active: false },
      { kind: "trackCompletion", taskId: "1" },
      { kind: "widgetUpdate" },
    ]);
  });

  it("cascade present → in_progress then spawnTask precede track/render (ORDER contract)", () => {
    const t1 = task({ id: "1", status: "in_progress", metadata: { agentType: "gp" } });
    const t2 = task({ id: "2", status: "pending", metadata: { agentType: "explore" }, blockedBy: ["1"] });
    const cmds = advanceTaskGraph(
      { kind: "completed", agentId: "a1", result: "R" },
      snap([t1, t2], [["a1", "1"]], { additionalContext: "ctx", model: "sonnet", maxTurns: 5 }),
    );
    expect(cmds.map((c) => c.kind)).toEqual([
      "deleteAgentMapping",
      "updateTask",
      "setActiveTask",
      "updateTask",
      "spawnTask",
      "trackCompletion",
      "widgetUpdate",
    ]);
    expect(cmds[3]).toEqual({ kind: "updateTask", taskId: "2", fields: { status: "in_progress" } });
    expect(cmds[4]).toEqual({
      kind: "spawnTask",
      taskId: "2",
      agentType: "explore",
      additionalContext: "ctx",
      spawnOptions: { description: "Task 2", isBackground: true, maxTurns: 5, model: "sonnet" },
    });
  });

  it("cascade off → unblocked task is NOT spawned", () => {
    const t1 = task({ id: "1", status: "in_progress", metadata: { agentType: "gp" } });
    const t2 = task({ id: "2", status: "pending", metadata: { agentType: "gp" }, blockedBy: ["1"] });
    const cmds = advanceTaskGraph({ kind: "completed", agentId: "a1" }, snap([t1, t2], [["a1", "1"]]));
    expect(cmds.map((c) => c.kind)).not.toContain("spawnTask");
  });

  it("cascade present but unblocked task lacks agentType → not spawned", () => {
    const t1 = task({ id: "1", status: "in_progress", metadata: { agentType: "gp" } });
    const t2 = task({ id: "2", status: "pending", metadata: {}, blockedBy: ["1"] });
    const cmds = advanceTaskGraph({ kind: "completed", agentId: "a1" }, snap([t1, t2], [["a1", "1"]], {}));
    expect(cmds.map((c) => c.kind)).not.toContain("spawnTask");
  });

  it("cascade present but a sibling dependency is still incomplete → not spawned", () => {
    const t1 = task({ id: "1", status: "in_progress", metadata: { agentType: "gp" } });
    const t3 = task({ id: "3", status: "pending", metadata: { agentType: "gp" } });
    const t2 = task({ id: "2", status: "pending", metadata: { agentType: "gp" }, blockedBy: ["1", "3"] });
    const cmds = advanceTaskGraph({ kind: "completed", agentId: "a1" }, snap([t1, t2, t3], [["a1", "1"]], {}));
    expect(cmds.map((c) => c.kind)).not.toContain("spawnTask");
  });
});

describe("advanceTaskGraph — failed (three distinct sub-paths)", () => {
  it("error → revert to pending with lastError, resetBatchCountdown", () => {
    const t1 = task({ id: "1", status: "in_progress", metadata: { agentType: "gp" } });
    const cmds = advanceTaskGraph({ kind: "failed", agentId: "a1", error: "boom", status: "error" }, snap([t1], [["a1", "1"]]));
    expect(cmds).toEqual([
      { kind: "deleteAgentMapping", agentId: "a1" },
      { kind: "updateTask", taskId: "1", fields: { status: "pending", metadata: { agentType: "gp", lastError: "boom" } } },
      { kind: "resetBatchCountdown" },
      { kind: "setActiveTask", taskId: "1", active: false },
      { kind: "widgetUpdate" },
    ]);
  });

  it("stopped + in_progress → finalize completed with result, trackCompletion", () => {
    const t1 = task({ id: "1", status: "in_progress", metadata: { agentType: "gp" } });
    const cmds = advanceTaskGraph({ kind: "failed", agentId: "a1", status: "stopped", result: "partial" }, snap([t1], [["a1", "1"]]));
    expect(cmds).toEqual([
      { kind: "deleteAgentMapping", agentId: "a1" },
      { kind: "updateTask", taskId: "1", fields: { status: "completed", metadata: { agentType: "gp", result: "partial" } } },
      { kind: "trackCompletion", taskId: "1" },
      { kind: "setActiveTask", taskId: "1", active: false },
      { kind: "widgetUpdate" },
    ]);
  });

  it("stopped finalize falls back to existing result when event carries none", () => {
    const t1 = task({ id: "1", status: "in_progress", metadata: { agentType: "gp", result: "prev" } });
    const cmds = advanceTaskGraph({ kind: "failed", agentId: "a1", status: "stopped" }, snap([t1], [["a1", "1"]]));
    expect(cmds[1]).toEqual({
      kind: "updateTask",
      taskId: "1",
      fields: { status: "completed", metadata: { agentType: "gp", result: "prev" } },
    });
  });

  it("stopped + already completed → backfill only, NO track/deactivate/render", () => {
    const t1 = task({ id: "1", status: "completed", metadata: { agentType: "gp" } });
    const cmds = advanceTaskGraph({ kind: "failed", agentId: "a1", status: "stopped", result: "late" }, snap([t1], [["a1", "1"]]));
    expect(cmds).toEqual([
      { kind: "deleteAgentMapping", agentId: "a1" },
      { kind: "updateTask", taskId: "1", fields: { metadata: { agentType: "gp", result: "late" } } },
    ]);
  });

  it("stopped + already completed + result already present → delete mapping only", () => {
    const t1 = task({ id: "1", status: "completed", metadata: { agentType: "gp", result: "existing" } });
    const cmds = advanceTaskGraph({ kind: "failed", agentId: "a1", status: "stopped", result: "late" }, snap([t1], [["a1", "1"]]));
    expect(cmds).toEqual([{ kind: "deleteAgentMapping", agentId: "a1" }]);
  });

  it("stopped + already completed + no event result → delete mapping only", () => {
    const t1 = task({ id: "1", status: "completed", metadata: { agentType: "gp" } });
    const cmds = advanceTaskGraph({ kind: "failed", agentId: "a1", status: "stopped" }, snap([t1], [["a1", "1"]]));
    expect(cmds).toEqual([{ kind: "deleteAgentMapping", agentId: "a1" }]);
  });
});
