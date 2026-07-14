// Phase 1.5b (Task 17) — stagnation cap for the task-tool continuation reminder.
// Covers the cap extension to ContinuationCooldown: after N consecutive
// no-progress reminders the helper stops firing, exposes a one-shot
// stagnation payload, and resets fully on any progress signal.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { REMINDER_INTERVAL } from "../src/constants.js";
import {
  CONTINUATION_REMINDER_STAGNATION_CAP,
  ContinuationCooldown,
} from "../src/continuation-cooldown.js";

const base = REMINDER_INTERVAL;
const CAP = CONTINUATION_REMINDER_STAGNATION_CAP;

describe("ContinuationCooldown — stagnation cap", () => {
  let cooldown: ContinuationCooldown;

  beforeEach(() => {
    cooldown = new ContinuationCooldown(base);
  });

  it("exposes the configured cap and starts non-stagnant", () => {
    expect(CONTINUATION_REMINDER_STAGNATION_CAP).toBeGreaterThan(0);
    expect(cooldown.cap).toBe(CAP);
    expect(cooldown.stagnant).toBe(false);
    expect(cooldown.consumeStagnationWarning()).toBeNull();
  });

  it("stops firing after exactly CAP reminders even if turnsSinceProgress is huge", () => {
    for (let i = 0; i < CAP; i++) {
      expect(cooldown.stagnant).toBe(false);
      expect(cooldown.shouldFire(1_000_000)).toBe(true);
      cooldown.recordFire();
    }
    expect(cooldown.attempt).toBe(CAP);
    expect(cooldown.stagnant).toBe(true);
    expect(cooldown.shouldFire(1_000_000)).toBe(false);
    expect(cooldown.shouldFire(base)).toBe(false);
  });

  it("consumeStagnationWarning yields { attempt, cap } exactly once per episode", () => {
    for (let i = 0; i < CAP; i++) cooldown.recordFire();
    const first = cooldown.consumeStagnationWarning();
    expect(first).toEqual({ attempt: CAP, cap: CAP });
    expect(cooldown.consumeStagnationWarning()).toBeNull();
    expect(cooldown.consumeStagnationWarning()).toBeNull();
  });

  it("returns null before cap is reached", () => {
    for (let i = 0; i < CAP - 1; i++) cooldown.recordFire();
    expect(cooldown.stagnant).toBe(false);
    expect(cooldown.consumeStagnationWarning()).toBeNull();
  });

  it("recordProgress resets stagnation state and resumes reminders", () => {
    for (let i = 0; i < CAP; i++) cooldown.recordFire();
    expect(cooldown.consumeStagnationWarning()).not.toBeNull();
    expect(cooldown.stagnant).toBe(true);
    expect(cooldown.shouldFire(1_000_000)).toBe(false);

    cooldown.recordProgress();

    expect(cooldown.attempt).toBe(0);
    expect(cooldown.stagnant).toBe(false);
    expect(cooldown.nextInterval).toBe(base);
    expect(cooldown.shouldFire(base)).toBe(true);
    // A new episode re-arms the warning.
    for (let i = 0; i < CAP; i++) cooldown.recordFire();
    expect(cooldown.consumeStagnationWarning()).toEqual({ attempt: CAP, cap: CAP });
  });

  it("hitting the cap does not throw or abort — caller stays in control", () => {
    for (let i = 0; i < CAP; i++) {
      expect(() => cooldown.recordFire()).not.toThrow();
    }
    expect(() => cooldown.shouldFire(0)).not.toThrow();
    expect(() => cooldown.consumeStagnationWarning()).not.toThrow();
    expect(() => cooldown.recordProgress()).not.toThrow();
    // Helper is still usable after a full episode.
    expect(cooldown.shouldFire(base)).toBe(true);
  });
});

describe("ContinuationCooldown — simulated stagnation episode with [panda-warn]", () => {
  it("Phase 1.5b cap suppresses reminders and emits exactly one stagnation warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cooldown = new ContinuationCooldown(base);
      let lastAnchor = 0;
      let fires = 0;
      let stagnationWarns = 0;
      let lastWarnPayload: unknown;

      // Run far past the point where the cap should engage.
      for (let turn = 1; turn <= base * 200; turn++) {
        const turnsSinceProgress = turn - lastAnchor;
        if (cooldown.shouldFire(turnsSinceProgress)) {
          const meta = cooldown.recordFire();
          console.warn("[panda-warn]", JSON.stringify({
            code: "tasks.continuation.reminder",
            ts: turn,
            attempt: meta.attempt,
            intervalMs: meta.intervalMs,
          }));
          fires++;
          lastAnchor = turn;
        } else if (
          cooldown.stagnant &&
          turnsSinceProgress >= cooldown.nextInterval
        ) {
          const stagnation = cooldown.consumeStagnationWarning();
          if (stagnation) {
            const payload = {
              code: "tasks.continuation.stagnation-cap",
              ts: turn,
              attempt: stagnation.attempt,
              cap: stagnation.cap,
            };
            console.warn("[panda-warn]", JSON.stringify(payload));
            stagnationWarns++;
            lastWarnPayload = payload;
            lastAnchor = turn;
          }
        }
      }

      expect(fires).toBe(CAP);
      expect(stagnationWarns).toBe(1);
      expect(lastWarnPayload).toMatchObject({
        code: "tasks.continuation.stagnation-cap",
        attempt: CAP,
        cap: CAP,
      });

      const stagnationCalls = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[1] === "string" &&
          (call[1] as string).includes("tasks.continuation.stagnation-cap"),
      );
      expect(stagnationCalls).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("progress between episodes re-arms a fresh stagnation warning", () => {
    const cooldown = new ContinuationCooldown(base);
    for (let i = 0; i < CAP; i++) cooldown.recordFire();
    expect(cooldown.consumeStagnationWarning()).toEqual({ attempt: CAP, cap: CAP });

    cooldown.recordProgress(); // task-tool use mid-session
    for (let i = 0; i < CAP; i++) cooldown.recordFire();
    expect(cooldown.consumeStagnationWarning()).toEqual({ attempt: CAP, cap: CAP });
  });
});
