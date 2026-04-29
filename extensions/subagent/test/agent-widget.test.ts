import { describe, expect, it } from "vitest";
import { formatTokens, formatTurns, formatMs, formatDuration, describeActivity } from "../src/ui/agent-widget.js";

// Nerd Font icon codepoints used in formatting:
// 󰾆 = U+F0F86 (nf-md-chip) — token counts
// 󱁤 = U+F1064 (nf-md-tools) — tool uses in UI renderers

describe("formatTokens", () => {
  it("formats millions with 󰾆 prefix", () => {
    expect(formatTokens(1_200_000)).toBe("󰾆 1.2M");
  });

  it("formats exactly 1M", () => {
    expect(formatTokens(1_000_000)).toBe("󰾆 1.0M");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(33_800)).toBe("󰾆 33.8k");
  });

  it("formats exactly 1k", () => {
    expect(formatTokens(1_000)).toBe("󰾆 1.0k");
  });

  it("formats small counts without suffix", () => {
    expect(formatTokens(500)).toBe("󰾆 500");
  });

  it("formats zero", () => {
    expect(formatTokens(0)).toBe("󰾆 0");
  });
});

describe("formatTurns", () => {
  it("formats turn count with space after ⟳", () => {
    expect(formatTurns(5)).toBe("⟳ 5");
  });

  it("includes max turns with ≤ separator", () => {
    expect(formatTurns(5, 30)).toBe("⟳ 5≤30");
  });

  it("omits max when null", () => {
    expect(formatTurns(3, null)).toBe("⟳ 3");
  });

  it("omits max when undefined", () => {
    expect(formatTurns(3, undefined)).toBe("⟳ 3");
  });

  it("handles zero turns", () => {
    expect(formatTurns(0)).toBe("⟳ 0");
  });

  it("handles turn count equal to max", () => {
    expect(formatTurns(50, 50)).toBe("⟳ 50≤50");
  });
});

describe("formatMs", () => {
  it("converts milliseconds to seconds", () => {
    expect(formatMs(5700)).toBe("5.7s");
  });

  it("handles sub-second", () => {
    expect(formatMs(300)).toBe("0.3s");
  });

  it("handles zero", () => {
    expect(formatMs(0)).toBe("0.0s");
  });

  it("handles large values", () => {
    expect(formatMs(125_400)).toBe("125.4s");
  });
});

describe("formatDuration", () => {
  it("uses completedAt when provided", () => {
    expect(formatDuration(1000, 6700)).toBe("5.7s");
  });

  it("shows (running) suffix when no completedAt", () => {
    const result = formatDuration(Date.now() - 3000);
    expect(result).toMatch(/^\d+\.\ds \(running\)$/);
  });
});

describe("describeActivity", () => {
  it("returns thinking… with no tools and no text", () => {
    expect(describeActivity(new Map())).toBe("thinking…");
  });

  it("describes a single active tool", () => {
    const tools = new Map([["call-1", "read"]]);
    expect(describeActivity(tools)).toBe("reading…");
  });

  it("groups multiple calls of same tool", () => {
    const tools = new Map([["c1", "read"], ["c2", "read"], ["c3", "read"]]);
    expect(describeActivity(tools)).toBe("reading 3 files…");
  });

  it("groups searching with patterns label", () => {
    const tools = new Map([["c1", "grep"], ["c2", "grep"]]);
    expect(describeActivity(tools)).toBe("searching 2 patterns…");
  });

  it("joins multiple tool types", () => {
    const tools = new Map([["c1", "read"], ["c2", "edit"]]);
    expect(describeActivity(tools)).toBe("reading, editing…");
  });

  it("shows truncated response text when no tools active", () => {
    const result = describeActivity(new Map(), "I found the issue in auth.ts");
    expect(result).toBe("I found the issue in auth.ts");
  });

  it("uses unknown tool name verbatim", () => {
    const tools = new Map([["c1", "custom_tool"]]);
    expect(describeActivity(tools)).toBe("custom_tool…");
  });
});
