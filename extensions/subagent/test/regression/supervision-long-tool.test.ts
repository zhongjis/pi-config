// Phase 1.1 red→green; do not skip
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_STALE_ABORT_AFTER_MS,
  BACKGROUND_STALE_STEER_AFTER_MS,
  getBackgroundSupervisionAction,
} from "../../src/background-supervision.js";

/**
 * Regression: a background subagent must NOT be aborted (or steered) by the
 * idle-supervisor while a tool is still actively executing. Long-running tools
 * (e.g. a slow `bash`, a multi-minute web fetch, a large `read`) do not emit
 * text deltas or turn-end progress, so the idle clock crosses the
 * steer/abort thresholds while the tool is still legitimately working.
 *
 * Current HEAD ignores `activeTools` and decides solely from
 * `lastProgressAt`, so this test exits non-zero on HEAD by design. The
 * follow-up green task will teach `getBackgroundSupervisionAction` to treat
 * a non-empty `activeTools` set as live progress.
 */
describe("background supervision — long-running tool", () => {
  const baseRecord = {
    status: "running",
    isBackground: true,
    startedAt: 0,
  } as const;

  it("does not abort while a tool is still executing past the abort threshold", () => {
    const now = BACKGROUND_STALE_ABORT_AFTER_MS + 1;
    const activeTools = new Map<string, string>([
      ["bash_" + String(now - 1000), "bash"],
    ]);

    const result = getBackgroundSupervisionAction({
      record: { ...baseRecord },
      activity: { lastProgressAt: 0, activeTools },
      now,
    });

    expect(result.action).toBe("none");
  });

  it("does not steer while a tool is still executing past the steer threshold", () => {
    const now = BACKGROUND_STALE_STEER_AFTER_MS + 1;
    const activeTools = new Map<string, string>([
      ["read_" + String(now - 500), "read"],
    ]);

    const result = getBackgroundSupervisionAction({
      record: { ...baseRecord },
      activity: { lastProgressAt: 0, activeTools },
      now,
    });

    expect(result.action).toBe("none");
  });
});
