// Phase 1.1 red→green; do not skip
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_STALE_ABORT_AFTER_MS,
  getBackgroundSupervisionAction,
} from "../../src/background-supervision.js";

/**
 * Regression: non-streaming providers (no token deltas) make a single long
 * model call and then emit one final response chunk. During that call,
 * `lastProgressAt` is never advanced by `onTextDelta`, so supervision sees
 * a long idle window and currently aborts the agent even though it is
 * actively in-flight.
 *
 * Expected (post-fix) behavior: supervision must NOT abort a running
 * background agent solely because no streaming token deltas have arrived.
 *
 * Uses the real `getBackgroundSupervisionAction` from
 * `src/background-supervision.ts` — supervision is not mocked.
 */
describe("regression: supervision must tolerate non-streaming providers", () => {
  it("does not abort a running background agent that has produced no token deltas yet", () => {
    const startedAt = 0;
    // Simulate a non-streaming provider mid-call: the request has been
    // running just past the abort threshold, and the activity tracker has
    // never received an `onTextDelta`, so `lastProgressAt` is still pinned
    // to `startedAt`.
    const now = startedAt + BACKGROUND_STALE_ABORT_AFTER_MS + 1_000;

    const result = getBackgroundSupervisionAction({
      record: {
        status: "running",
        isBackground: true,
        startedAt,
      },
      activity: { lastProgressAt: startedAt },
      now,
    });

    // Current code returns { action: "abort", idleMs: now } here — this is
    // the regression we want fixed. After Phase 1.1, supervision should
    // recognize the agent as still actively executing a non-streaming call
    // and return something other than "abort".
    expect(result.action).not.toBe("abort");
  });

  it("does not abort when only the final response chunk arrives after a long non-streaming call", () => {
    const startedAt = 0;
    // The single final response chunk arrives just past the abort threshold.
    // Even with one terminal `onTextDelta`, supervision should not have
    // already aborted the in-flight request beforehand.
    const finalChunkAt = startedAt + BACKGROUND_STALE_ABORT_AFTER_MS + 500;

    const result = getBackgroundSupervisionAction({
      record: {
        status: "running",
        isBackground: true,
        startedAt,
      },
      activity: { lastProgressAt: startedAt },
      now: finalChunkAt,
    });

    expect(result.action).not.toBe("abort");
  });
});
