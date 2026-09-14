/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

import type { Usage } from "@earendil-works/pi-ai";

/**
 * Per-message billing deltas accumulated independently of session history.
 * cacheRead is billed on each call but excluded from the display total (#38).
 * cost is the total dollar amount, not a per-kind pricing breakdown.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cacheRead?: number; cost?: number };

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  if (delta.cacheRead) into.cacheRead = (into.cacheRead ?? 0) + delta.cacheRead;
  if (delta.cost) into.cost = (into.cost ?? 0) + delta.cost;
}

/** Unreported billing deltas; draining transfers ownership to one native tool result. */
export class PendingUsagePool {
  private pending: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };

  add(delta: LifetimeUsage): void {
    addUsage(this.pending, delta);
  }

  drain(): Usage | undefined {
    const { input, output, cacheWrite, cacheRead = 0, cost = 0 } = this.pending;
    this.pending = { input: 0, output: 0, cacheWrite: 0 };
    if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0 && cost === 0) return undefined;
    return {
      input, output, cacheRead, cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      // ponytail: total-only pricing; retain per-category Usage deltas if a cost breakdown is needed.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
  }
}

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens`. Pi 0.85.1 aggregates all session entries,
 * including those before compaction. The lifetime accumulator instead tracks
 * the message events observed by this manager.
 *
 * Avoids upstream's `tokens.total` field, which sums per-turn `cacheRead`
 * and so counts the cumulative cached prefix N times across N turns
 * (issue #38).
 */
export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch { return 0; }
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try { return session.getSessionStats().contextUsage?.percent ?? null; }
  catch { return null; }
}
