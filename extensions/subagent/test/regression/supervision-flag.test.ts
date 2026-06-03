// Phase 1.1b red→green; do not skip
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_STALE_ABORT_AFTER_MS,
  BACKGROUND_SUPERVISION_COOLDOWN_MS,
  getBackgroundSupervisionAction,
  parseBackgroundSupervisionMode,
} from "../../src/background-supervision.js";

describe("regression: supervision feature flag", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to v2 supervision", () => {
    vi.stubEnv("PI_SUBAGENT_SUPERVISION", "");

    expect(parseBackgroundSupervisionMode()).toBe("v2");
  });

  it("keeps v2 active-tool protection by default", () => {
    const now = BACKGROUND_STALE_ABORT_AFTER_MS + 1;

    const result = getBackgroundSupervisionAction({
      record: { status: "running", isBackground: true, startedAt: 0 },
      activity: {
        lastProgressAt: 0,
        activeTools: new Map([["bash_1", "bash"]]),
        streamingDeltasSeen: true,
      },
      now,
    });

    expect(result.action).toBe("none");
  });

  it("restores legacy supervision without the active-tool guard", () => {
    const now = BACKGROUND_STALE_ABORT_AFTER_MS + 1;

    const result = getBackgroundSupervisionAction({
      record: { status: "running", isBackground: true, startedAt: 0 },
      activity: {
        lastProgressAt: 0,
        activeTools: new Map([["bash_1", "bash"]]),
      },
      now,
      mode: "legacy",
    });

    expect(result.action).toBe("abort");
  });

  it("restores legacy token-idle abort instead of v2 non-stream suppression", () => {
    const now = BACKGROUND_STALE_ABORT_AFTER_MS + 1;
    const lastSupervisionSteerAt = now - BACKGROUND_SUPERVISION_COOLDOWN_MS + 1_000;

    const result = getBackgroundSupervisionAction({
      record: {
        status: "running",
        isBackground: true,
        startedAt: 0,
        lastSupervisionSteerAt,
      },
      activity: { lastProgressAt: 0, streamingDeltasSeen: false },
      now,
      mode: "legacy",
    });

    expect(result.action).toBe("abort");
    expect(result.markNonStreaming).toBeUndefined();
  });
});
