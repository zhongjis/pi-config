/**
 * continuation-cooldown.ts — Cooldown + exponential backoff for the task-tool
 * continuation reminder (Phase 1.5a, Task 16).
 *
 * The reminder system is turn-based. Before Task 16 the reminder fired on a
 * fixed REMINDER_INTERVAL (4 turns) cadence whenever non-task tools ran while
 * tasks existed and the agent had not touched the task tools recently. That
 * was noisy on long stretches of non-task work.
 *
 * Cooldown + backoff schedule (factor = 2, base = REMINDER_INTERVAL):
 *   attempt 1 fires at   base turns idle
 *   attempt 2 fires at 2*base turns idle
 *   attempt 3 fires at 4*base turns idle
 *   ...
 *   capped at 10*base turns idle (per Phase 1.5a spec)
 *
 * "Progress" (any task-tool use, or an explicit recordProgress() call) resets
 * the attempt counter so the next reminder again fires at base.
 *
 * Pure helper: no I/O, no globals. Caller owns time (turn counter) and emits
 * the [panda-warn] message — this module only decides cadence.
 * Task 17 (stagnation cap) reuses this attempt counter: after a named
 * constant number of consecutive no-progress reminders, `shouldFire` stops
 * returning true and `consumeStagnationWarning` yields a one-shot payload
 * the caller embeds in a `[panda-warn]` entry. Any progress resets state.
 */

/**
 * unit: count
 * source: Phase 1.5a (Task 16) spec
 * rationale: cap the reminder interval at 10 × base to avoid unbounded backoff.
 */
export const CONTINUATION_REMINDER_CAP_MULTIPLIER = 10;

/**
 * unit: count
 * source: Phase 1.5a (Task 16) spec
 * rationale: exponential backoff doubling between reminder attempts.
 */
export const CONTINUATION_REMINDER_BACKOFF_FACTOR = 2;

/**
 * unit: count
 * source: Phase 1.5b (Task 17) spec
 * rationale: after this many consecutive no-progress reminders, stop emitting
 *   reminder entries and surface a single [panda-warn] stagnation signal.
 */
export const CONTINUATION_REMINDER_STAGNATION_CAP = 5;

export class ContinuationCooldown {
  /** Number of reminders already fired since last progress reset (0 = none yet). */
  private attemptCount = 0;
  /** True after the stagnation warning has been consumed this episode. */
  private stagnationWarned = false;

  constructor(
    /** Base interval in turns (Task 15: REMINDER_INTERVAL). */
    private readonly baseInterval: number,
    private readonly factor: number = CONTINUATION_REMINDER_BACKOFF_FACTOR,
    private readonly capMultiplier: number = CONTINUATION_REMINDER_CAP_MULTIPLIER,
    private readonly stagnationCap: number = CONTINUATION_REMINDER_STAGNATION_CAP,
  ) {}

  /** Number of reminders fired since last progress reset. */
  get attempt(): number {
    return this.attemptCount;
  }

  /** Configured stagnation cap (max reminders per no-progress episode). */
  get cap(): number {
    return this.stagnationCap;
  }

  /** True once `attemptCount` has reached the stagnation cap. */
  get stagnant(): boolean {
    return this.attemptCount >= this.stagnationCap;
  }

  /** Interval (turns) the NEXT reminder will wait for, given the current attempt count. */
  get nextInterval(): number {
    const cap = this.baseInterval * this.capMultiplier;
    const raw = this.baseInterval * this.factor ** this.attemptCount;
    return Math.min(raw, cap);
  }

  /** True iff `turnsSinceProgress` has reached the current interval threshold. */
  shouldFire(turnsSinceProgress: number): boolean {
    if (this.stagnant) return false;
    return turnsSinceProgress >= this.nextInterval;
  }

  /**
   * Return a one-shot stagnation payload the first time it is called while
   * the cap is active; subsequent calls in the same episode return null.
   * `recordProgress()` re-arms the warning for the next episode.
   */
  consumeStagnationWarning(): { attempt: number; cap: number } | null {
    if (!this.stagnant) return null;
    if (this.stagnationWarned) return null;
    this.stagnationWarned = true;
    return { attempt: this.attemptCount, cap: this.stagnationCap };
  }

  /**
   * Record that a reminder was just fired. Returns the metadata for the
   * caller to embed in the [panda-warn] payload.
   *
   * NOTE: `intervalMs` field name follows the Phase 1.5a spec verbatim even
   * though the reminder is turn-based. The numeric value is the interval in
   * turns (the unit of REMINDER_INTERVAL); callers should not treat it as
   * milliseconds.
   */
  recordFire(): { attempt: number; intervalMs: number } {
    const interval = this.nextInterval;
    this.attemptCount += 1;
    return { attempt: this.attemptCount, intervalMs: interval };
  }

  /** Reset attempt counter so the next reminder again fires at base. */
  recordProgress(): void {
    this.attemptCount = 0;
    this.stagnationWarned = false;
  }
}
