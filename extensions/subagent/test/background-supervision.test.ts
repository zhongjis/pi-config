import { describe, expect, it } from "vitest";
import {
  BACKGROUND_STALE_ABORT_AFTER_MS,
  BACKGROUND_STALE_STEER_AFTER_MS,
  BACKGROUND_SUPERVISION_COOLDOWN_MS,
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

  it("aborts very stale background agents once", () => {
    const now = BACKGROUND_STALE_ABORT_AFTER_MS + 1;
    expect(
      getBackgroundSupervisionAction({
        record: { status: "running", isBackground: true, startedAt: 0 },
        activity: { lastProgressAt: 0 },
        now,
      }),
    ).toEqual({ action: "abort", idleMs: now });
  });
});
