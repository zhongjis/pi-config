import { describe, expect, it } from "vitest";
import { groupByStatus } from "../status-group.js";

describe("groupByStatus", () => {
  it("groups every status used by subagent and tasks", () => {
    const items = [
      { id: "1", status: "running" },
      { id: "2", status: "queued" },
      { id: "3", status: "completed" },
      { id: "4", status: "steered" },
      { id: "5", status: "aborted" },
      { id: "6", status: "stopped" },
      { id: "7", status: "error" },
      { id: "8", status: "background" },
      { id: "9", status: "in_progress" },
      { id: "10", status: "pending" },
    ] as const;

    expect(groupByStatus(items)).toEqual({
      running: [items[0]],
      queued: [items[1]],
      completed: [items[2]],
      steered: [items[3]],
      aborted: [items[4]],
      stopped: [items[5]],
      error: [items[6]],
      background: [items[7]],
      in_progress: [items[8]],
      pending: [items[9]],
    });
  });

  it("preserves item order within each status group", () => {
    const items = [
      { id: "1", status: "pending" },
      { id: "2", status: "running" },
      { id: "3", status: "pending" },
      { id: "4", status: "running" },
      { id: "5", status: "pending" },
    ] as const;

    const grouped = groupByStatus(items);

    expect(grouped.pending).toEqual([items[0], items[2], items[4]]);
    expect(grouped.running).toEqual([items[1], items[3]]);
  });

  it("returns an empty object for empty input", () => {
    expect(groupByStatus([])).toEqual({});
  });
});
