// Phase 1.5a (Task 16) — continuation reminder cooldown + exponential backoff.
// Covers the pure ContinuationCooldown helper used by extensions/tasks/src/index.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { REMINDER_INTERVAL } from "../src/constants.js";
import {
  CONTINUATION_REMINDER_BACKOFF_FACTOR,
  CONTINUATION_REMINDER_CAP_MULTIPLIER,
  ContinuationCooldown,
} from "../src/continuation-cooldown.js";

describe("ContinuationCooldown — backoff schedule", () => {
  const base = REMINDER_INTERVAL;
  let cooldown: ContinuationCooldown;

  beforeEach(() => {
    cooldown = new ContinuationCooldown(base);
  });

  it("uses constants matching the Phase 1.5a spec (factor 2, cap 10x)", () => {
    expect(CONTINUATION_REMINDER_BACKOFF_FACTOR).toBe(2);
    expect(CONTINUATION_REMINDER_CAP_MULTIPLIER).toBe(10);
  });

  it("first reminder fires at base, second at 2*base, third at 4*base, capped at 10*base", () => {
    // attempt 0 → interval = base
    expect(cooldown.nextInterval).toBe(base);
    expect(cooldown.shouldFire(base - 1)).toBe(false);
    expect(cooldown.shouldFire(base)).toBe(true);
    expect(cooldown.recordFire()).toEqual({ attempt: 1, intervalMs: base });

    // attempt 1 → interval = 2*base
    expect(cooldown.nextInterval).toBe(2 * base);
    expect(cooldown.shouldFire(2 * base - 1)).toBe(false);
    expect(cooldown.shouldFire(2 * base)).toBe(true);
    expect(cooldown.recordFire()).toEqual({ attempt: 2, intervalMs: 2 * base });

    // attempt 2 → interval = 4*base
    expect(cooldown.nextInterval).toBe(4 * base);
    expect(cooldown.recordFire()).toEqual({ attempt: 3, intervalMs: 4 * base });

    // attempt 3 → interval = 8*base
    expect(cooldown.nextInterval).toBe(8 * base);
    expect(cooldown.recordFire()).toEqual({ attempt: 4, intervalMs: 8 * base });

    // attempt 4 → raw would be 16*base, capped at 10*base
    expect(cooldown.nextInterval).toBe(10 * base);
    expect(cooldown.recordFire()).toEqual({ attempt: 5, intervalMs: 10 * base });

    // every subsequent reminder stays at the cap
    expect(cooldown.nextInterval).toBe(10 * base);
    expect(cooldown.recordFire()).toEqual({ attempt: 6, intervalMs: 10 * base });
    expect(cooldown.recordFire()).toEqual({ attempt: 7, intervalMs: 10 * base });
    expect(cooldown.nextInterval).toBe(10 * base);
  });

  it("recordProgress resets attempt and interval to base", () => {
    cooldown.recordFire(); // → attempt 1, next = 2*base
    cooldown.recordFire(); // → attempt 2, next = 4*base
    expect(cooldown.attempt).toBe(2);
    expect(cooldown.nextInterval).toBe(4 * base);

    cooldown.recordProgress();
    expect(cooldown.attempt).toBe(0);
    expect(cooldown.nextInterval).toBe(base);
    expect(cooldown.shouldFire(base)).toBe(true);
    expect(cooldown.recordFire()).toEqual({ attempt: 1, intervalMs: base });
  });

  it("shouldFire requires turnsSinceProgress to reach the current interval", () => {
    expect(cooldown.shouldFire(0)).toBe(false);
    expect(cooldown.shouldFire(base - 1)).toBe(false);
    expect(cooldown.shouldFire(base)).toBe(true);
    cooldown.recordFire();
    // After fire, threshold doubled — same elapsed value should no longer trigger.
    expect(cooldown.shouldFire(base)).toBe(false);
    expect(cooldown.shouldFire(2 * base)).toBe(true);
  });
});

describe("ContinuationCooldown — interaction with [panda-warn] payload", () => {
  it("recordFire returns { attempt, intervalMs } suitable for the warn payload", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cooldown = new ContinuationCooldown(REMINDER_INTERVAL);
      const meta = cooldown.recordFire();
      console.warn("[panda-warn]", JSON.stringify({
        code: "tasks.continuation.reminder",
        ts: 1,
        attempt: meta.attempt,
        intervalMs: meta.intervalMs,
      }));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [marker, payloadJson] = warnSpy.mock.calls[0] as [string, string];
      expect(marker).toBe("[panda-warn]");
      const payload = JSON.parse(payloadJson);
      expect(payload.code).toBe("tasks.continuation.reminder");
      expect(payload.attempt).toBe(1);
      expect(payload.intervalMs).toBe(REMINDER_INTERVAL);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("intervalMs grows on subsequent fires and caps at 10 * base", () => {
    const cooldown = new ContinuationCooldown(REMINDER_INTERVAL);
    const intervals: number[] = [];
    for (let i = 0; i < 8; i++) {
      intervals.push(cooldown.recordFire().intervalMs);
    }
    expect(intervals).toEqual([
      REMINDER_INTERVAL,
      2 * REMINDER_INTERVAL,
      4 * REMINDER_INTERVAL,
      8 * REMINDER_INTERVAL,
      10 * REMINDER_INTERVAL,
      10 * REMINDER_INTERVAL,
      10 * REMINDER_INTERVAL,
      10 * REMINDER_INTERVAL,
    ]);
  });
});

describe("ContinuationCooldown — simulated long stretch of non-task tool calls", () => {
  // Models the index.ts wiring: lastTaskToolUseTurn restarts on every fire
  // (cooldown anchor) and on every task-tool use (progress reset).
  it("fires at cumulative turns base, base+2*base, base+2*base+4*base, ... then every cap turns", () => {
    const base = REMINDER_INTERVAL;
    // Isolate Task 16 backoff scheduling from Task 17 stagnation cap.
    const cooldown = new ContinuationCooldown(base, undefined, undefined, Number.POSITIVE_INFINITY);
    let lastAnchor = 0;
    const fires: Array<{ turn: number; attempt: number; intervalMs: number }> = [];

    for (let turn = 1; turn <= base * 60 && fires.length < 7; turn++) {
      if (cooldown.shouldFire(turn - lastAnchor)) {
        const meta = cooldown.recordFire();
        fires.push({ turn, attempt: meta.attempt, intervalMs: meta.intervalMs });
        lastAnchor = turn;
      }
    }

    expect(fires).toEqual([
      { turn: base, attempt: 1, intervalMs: base },
      { turn: base + 2 * base, attempt: 2, intervalMs: 2 * base },
      { turn: base + 2 * base + 4 * base, attempt: 3, intervalMs: 4 * base },
      { turn: base + 2 * base + 4 * base + 8 * base, attempt: 4, intervalMs: 8 * base },
      { turn: base + 2 * base + 4 * base + 8 * base + 10 * base, attempt: 5, intervalMs: 10 * base },
      { turn: base + 2 * base + 4 * base + 8 * base + 20 * base, attempt: 6, intervalMs: 10 * base },
      { turn: base + 2 * base + 4 * base + 8 * base + 30 * base, attempt: 7, intervalMs: 10 * base },
    ]);
  });

  it("progress in the middle of a long stretch resets the cadence back to base", () => {
    const base = REMINDER_INTERVAL;
    const cooldown = new ContinuationCooldown(base);
    cooldown.recordFire(); // attempt 1
    cooldown.recordFire(); // attempt 2 (next interval would be 4*base)

    cooldown.recordProgress(); // task-tool use

    // After progress, next reminder again fires at base.
    expect(cooldown.shouldFire(base - 1)).toBe(false);
    expect(cooldown.shouldFire(base)).toBe(true);
    expect(cooldown.recordFire()).toEqual({ attempt: 1, intervalMs: base });
    expect(cooldown.recordFire()).toEqual({ attempt: 2, intervalMs: 2 * base });
  });
});
