// Phase 0 characterization net — locks GroupJoinManager grouping behavior (audit gap #9,
// the riskiest wholly-uncovered contract) before D6 reworks it onto the event bus.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../src/group-join.js";
import { GroupJoinManager } from "../../src/group-join.js";

function rec(id: string): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: `agent ${id}`,
    status: "completed",
    toolUses: 0,
    startedAt: 0,
  } as AgentRecord;
}

describe("GroupJoinManager — grouped completion (Phase 0 characterization)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ungrouped agents return 'pass' and never trigger a grouped delivery", () => {
    const deliver = vi.fn();
    const gjm = new GroupJoinManager(deliver);
    expect(gjm.onAgentComplete(rec("x"))).toBe("pass");
    expect(gjm.isGrouped("x")).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("holds completions until the whole group finishes, then delivers once (partial=false)", () => {
    const deliver = vi.fn();
    const gjm = new GroupJoinManager(deliver);
    gjm.registerGroup("g1", ["a", "b", "c"]);
    expect(gjm.isGrouped("a")).toBe(true);

    expect(gjm.onAgentComplete(rec("a"))).toBe("held");
    expect(gjm.onAgentComplete(rec("b"))).toBe("held");
    expect(deliver).not.toHaveBeenCalled();

    expect(gjm.onAgentComplete(rec("c"))).toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(1);
    const [records, partial] = deliver.mock.calls[0];
    expect(records.map((r: AgentRecord) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect(partial).toBe(false);
  });

  it("after delivery the group is cleaned up — further completions 'pass'", () => {
    const deliver = vi.fn();
    const gjm = new GroupJoinManager(deliver);
    gjm.registerGroup("g1", ["a", "b"]);
    gjm.onAgentComplete(rec("a"));
    gjm.onAgentComplete(rec("b"));
    expect(deliver).toHaveBeenCalledTimes(1);
    // a late duplicate completion is no longer grouped
    expect(gjm.isGrouped("a")).toBe(false);
    expect(gjm.onAgentComplete(rec("a"))).toBe("pass");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("delivers partial on timeout (partial=true) and re-batches remaining as stragglers", () => {
    const deliver = vi.fn();
    const gjm = new GroupJoinManager(deliver, 1000);
    gjm.registerGroup("g1", ["a", "b", "c"]);

    expect(gjm.onAgentComplete(rec("a"))).toBe("held");
    // timeout fires before b/c complete → partial delivery of {a}
    vi.advanceTimersByTime(1000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].map((r: AgentRecord) => r.id)).toEqual(["a"]);
    expect(deliver.mock.calls[0][1]).toBe(true);

    // remaining {b,c} form a straggler group; completing both delivers again (partial=false)
    expect(gjm.onAgentComplete(rec("b"))).toBe("held");
    expect(gjm.onAgentComplete(rec("c"))).toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][0].map((r: AgentRecord) => r.id).sort()).toEqual(["b", "c"]);
    expect(deliver.mock.calls[1][1]).toBe(false);
  });

  it("dispose clears pending timers — no delivery fires afterward", () => {
    const deliver = vi.fn();
    const gjm = new GroupJoinManager(deliver, 1000);
    gjm.registerGroup("g1", ["a", "b"]);
    gjm.onAgentComplete(rec("a"));
    gjm.dispose();
    vi.advanceTimersByTime(10 * 60_000);
    expect(deliver).not.toHaveBeenCalled();
  });
});
