import { describe, expect, it } from "vitest";
import {
  BACKGROUND_STALE_ABORT_AFTER_MS,
  BACKGROUND_STALE_STEER_AFTER_MS,
  BACKGROUND_SUPERVISION_COOLDOWN_MS,
  DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS,
  getBackgroundSupervisionAction,
  getLastProgressAt,
} from "../src/background-supervision.js";

describe("background supervision", () => {
  it("uses startedAt when no activity timestamp exists", () => {
    expect(getLastProgressAt(undefined, 42)).toBe(42);
  });

  it("does nothing for foreground agents", () => {
    expect(
      getBackgroundSupervisionAction({
        record: { status: "running", isBackground: false, startedAt: 0 },
        now: BACKGROUND_STALE_ABORT_AFTER_MS + 1,
      }),
    ).toEqual({ action: "none", idleMs: 0 });
  });

  it("steers stale running background agents", () => {
    const now = BACKGROUND_STALE_STEER_AFTER_MS + 1;
    expect(
      getBackgroundSupervisionAction({
        record: { status: "running", isBackground: true, startedAt: 0 },
        activity: { lastProgressAt: 0 },
        now,
      }),
    ).toEqual({ action: "steer", idleMs: now });
  });

  it("respects steer cooldown before steering again", () => {
    const now = BACKGROUND_STALE_STEER_AFTER_MS + 1;
    expect(
      getBackgroundSupervisionAction({
        record: {
          status: "running",
          isBackground: true,
          startedAt: 0,
          lastSupervisionSteerAt: now - BACKGROUND_SUPERVISION_COOLDOWN_MS + 1000,
        },
        activity: { lastProgressAt: 0 },
        now,
      }),
    ).toEqual({ action: "none", idleMs: now });
  });

  it("aborts very stale background agents once after a prior steer", () => {
    const now = BACKGROUND_STALE_ABORT_AFTER_MS + 1;
    expect(
      getBackgroundSupervisionAction({
        record: {
          status: "running",
          isBackground: true,
          startedAt: 0,
          lastSupervisionSteerAt: now - BACKGROUND_SUPERVISION_COOLDOWN_MS + 1000,
        },
        activity: { lastProgressAt: 0 },
        now,
      }),
    ).toEqual({ action: "abort", idleMs: now });
  });

  // ---- Ported wave TDD cases ----

  it("[pure happy] steers a stale background agent with no active tools (v2)", () => {
    const now = 10 * 60_000;
    const threeMinAgo = now - 3 * 60_000;
    const result = getBackgroundSupervisionAction({
      record: { status: "running", isBackground: true, startedAt: threeMinAgo },
      activity: { lastProgressAt: threeMinAgo, activeTools: { size: 0 } },
      now,
      mode: "v2",
    });
    expect(result.action).toBe("steer");
  });

  it("[pure edge busy] does nothing while a tool is active (v2)", () => {
    const now = 10 * 60_000;
    const threeMinAgo = now - 3 * 60_000;
    const result = getBackgroundSupervisionAction({
      record: { status: "running", isBackground: true, startedAt: threeMinAgo },
      activity: { lastProgressAt: threeMinAgo, activeTools: { size: 1 } },
      now,
      mode: "v2",
    });
    expect(result.action).toBe("none");
  });

  it("[pure edge ceiling] aborts on ceiling with reasonClass 'ceiling'", () => {
    const now = 100 * 60_000;
    const startedAt = now - 31 * 60_000;
    const result = getBackgroundSupervisionAction({
      record: { status: "running", isBackground: true, startedAt },
      activity: { lastProgressAt: now, activeTools: { size: 0 } },
      now,
      mode: "v2",
      ceilingMs: DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS,
    });
    expect(result.action).toBe("abort");
    expect(result.reasonClass).toBe("ceiling");
  });

  it("[pure regression] does nothing when isBackground is undefined", () => {
    const now = BACKGROUND_STALE_ABORT_AFTER_MS + 1;
    expect(
      getBackgroundSupervisionAction({
        record: { status: "running", startedAt: 0 },
        activity: { lastProgressAt: 0, activeTools: { size: 0 } },
        now,
      }),
    ).toEqual({ action: "none", idleMs: 0 });
  });
});
