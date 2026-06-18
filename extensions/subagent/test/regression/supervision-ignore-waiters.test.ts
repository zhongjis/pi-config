// Phase 3 — locks the ignoreWaiters flag that lets the foreground supervised wait reuse
// getBackgroundSupervisionAction (instead of a duplicate inline if-tree). Background scan
// keeps deferring to an active waiter; the waiter itself opts out of that deferral.
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_STALE_STEER_AFTER_MS,
  DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS,
  getBackgroundSupervisionAction,
} from "../../src/background-supervision.js";

const baseRecord = {
  status: "running" as const,
  isBackground: true,
  startedAt: 0,
  waitingConsumers: 1, // someone is actively waiting via get_subagent_result
};

describe("getBackgroundSupervisionAction — ignoreWaiters", () => {
  it("default (background scan) defers to an active waiter → none", () => {
    const now = BACKGROUND_STALE_STEER_AFTER_MS + 10_000; // well past the steer threshold
    const res = getBackgroundSupervisionAction({
      record: baseRecord,
      activity: { lastProgressAt: 0, activeTools: { size: 0 }, streamingDeltasSeen: true },
      now,
    });
    expect(res.action).toBe("none");
  });

  it("ignoreWaiters=true (the waiter itself) does NOT defer → steers an idle agent", () => {
    const now = BACKGROUND_STALE_STEER_AFTER_MS + 10_000;
    const res = getBackgroundSupervisionAction({
      record: baseRecord,
      activity: { lastProgressAt: 0, activeTools: { size: 0 }, streamingDeltasSeen: true },
      now,
      ignoreWaiters: true,
    });
    expect(res.action).toBe("steer");
  });

  it("ceiling abort fires regardless of waiters (with ignoreWaiters)", () => {
    const now = DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS + 1;
    const res = getBackgroundSupervisionAction({
      record: baseRecord,
      activity: { lastProgressAt: now, activeTools: { size: 0 }, streamingDeltasSeen: true },
      now,
      ignoreWaiters: true,
    });
    expect(res.action).toBe("abort");
    expect(res.reasonClass).toBe("ceiling");
  });

  it("ignoreWaiters=true still skips when a tool is active (v2)", () => {
    const now = BACKGROUND_STALE_STEER_AFTER_MS + 10_000;
    const res = getBackgroundSupervisionAction({
      record: baseRecord,
      activity: { lastProgressAt: 0, activeTools: { size: 1 }, streamingDeltasSeen: true },
      now,
      ignoreWaiters: true,
    });
    expect(res.action).toBe("none");
  });
});
