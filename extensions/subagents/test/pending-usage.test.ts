import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { addUsage, getLifetimeTotal, type LifetimeUsage, PendingUsagePool } from "../src/usage.js";

describe("pending usage", () => {
  it("accumulates billed cache reads without changing display tokens", () => {
    const usage: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
    addUsage(usage, { input: 10, output: 20, cacheWrite: 5, cacheRead: 100, cost: 0.25 });
    expect(usage).toEqual({ input: 10, output: 20, cacheWrite: 5, cacheRead: 100, cost: 0.25 });
    expect(getLifetimeTotal(usage)).toBe(35);
  });

  it("drains each delta once with a native total-only cost breakdown", () => {
    const pool = new PendingUsagePool();
    expect(pool.drain()).toBeUndefined();
    pool.add({ input: 10, output: 20, cacheWrite: 5, cacheRead: 100, cost: 0.25 });
    pool.add({ input: 2, output: 3, cacheWrite: 1, cacheRead: 4, cost: 0.5 });
    const reported: Usage | undefined = pool.drain();
    expect(reported).toEqual({ input: 12, output: 23, cacheWrite: 6, cacheRead: 104, totalTokens: 145,
      cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0.75 } });
    expect(pool.drain()).toBeUndefined();
    pool.add({ input: 1, output: 0, cacheWrite: 0 });
    expect(pool.drain()?.totalTokens).toBe(1);
    expect(reported?.totalTokens).toBe(145);
  });

  it("reports tokens even with zero pricing and omits entirely empty deltas", () => {
    const pool = new PendingUsagePool();
    pool.add({ input: 0, output: 0, cacheWrite: 0, cacheRead: 9, cost: 0 });
    expect(pool.drain()).toMatchObject({ cacheRead: 9, totalTokens: 9, cost: { total: 0 } });
    pool.add({ input: 0, output: 0, cacheWrite: 0 });
    expect(pool.drain()).toBeUndefined();
  });
});
