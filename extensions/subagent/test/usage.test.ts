import { describe, expect, it } from "vitest";
import { addUsage, formatLifetimeTokens, type LifetimeUsage } from "../src/usage.js";

describe("addUsage", () => {
  it("accumulates input, output, cacheWrite — excludes cacheRead", () => {
    const acc: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
    addUsage(acc, { input: 100, output: 50, cacheWrite: 200 });
    addUsage(acc, { input: 300, output: 150, cacheWrite: 400 });
    expect(acc.input).toBe(400);
    expect(acc.output).toBe(200);
    expect(acc.cacheWrite).toBe(600);
    // No cacheRead field on LifetimeUsage
    expect("cacheRead" in acc).toBe(false);
  });

  it("starts at zero and stays zero with empty deltas", () => {
    const acc: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
    addUsage(acc, { input: 0, output: 0, cacheWrite: 0 });
    expect(acc.input).toBe(0);
    expect(acc.output).toBe(0);
    expect(acc.cacheWrite).toBe(0);
  });
});

describe("formatLifetimeTokens", () => {
  it("formats values < 1000 as plain number", () => {
    const result = formatLifetimeTokens({ input: 10, output: 5, cacheWrite: 0 });
    expect(result).toBe("15");
  });

  it("formats values >= 1000 with k suffix", () => {
    const result = formatLifetimeTokens({ input: 10_000, output: 4_500, cacheWrite: 0 });
    expect(result).toBe("14.5k");
  });

  it("formats values >= 1_000_000 with M suffix", () => {
    const result = formatLifetimeTokens({ input: 1_200_000, output: 0, cacheWrite: 0 });
    expect(result).toBe("1.2M");
  });

  it("includes cacheWrite in total", () => {
    const result = formatLifetimeTokens({ input: 0, output: 0, cacheWrite: 5_000 });
    expect(result).toBe("5k");
  });
});
