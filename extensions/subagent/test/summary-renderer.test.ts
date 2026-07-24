import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderSubagentSummary } from "../src/ui/summary-renderer.js";

describe("renderSubagentSummary", () => {
  it("renders running agent status with compact stats and activity", () => {
    expect(renderSubagentSummary({
      displayName: "Explore",
      description: "Trace blinking",
      status: "running",
      activity: "reading files…",
      spinnerFrame: 2,
      modelName: "sonnet",
      turnCount: 3,
      maxTurns: 12,
      toolUses: 4,
      totalTokens: 12_300,
      durationMs: 5700,
    })).toMatchInlineSnapshot(`
      [
        "⠹ Explore Trace blinking · sonnet · ↻3≤12 · 4 tools · 12.3k · 5.7s",
        "└─ reading files…",
      ]
    `);
  });

  it("renders completed agent status with result preview", () => {
    expect(renderSubagentSummary({
      displayName: "Plan",
      description: "Draft fix",
      status: "completed",
      resultPreview: "Use stable widget callback and requestRender.",
      turnCount: 5,
      toolUses: 2,
      tokens: "9.8k",
      durationMs: 12_400,
    })).toMatchInlineSnapshot(`
      [
        "✓ Plan Draft fix · ↻5 · 2 tools · 9.8k · 12s",
        "└─ Use stable widget callback and requestRender.",
      ]
    `);
  });

  it("renders compaction count when greater than zero", () => {
    expect(renderSubagentSummary({
      displayName: "Explore",
      description: "Long crawl",
      status: "running",
      activity: "reading files…",
      spinnerFrame: 2,
      turnCount: 8,
      toolUses: 4,
      compactionCount: 2,
      totalTokens: 50_000,
      durationMs: 5700,
    })).toEqual([
      "⠹ Explore Long crawl · ↻8 · ⇲2 · 4 tools · 50k · 5.7s",
      "└─ reading files…",
    ]);
  });

  it("renders grouped summaries with child previews", () => {
    expect(renderSubagentSummary({
      title: "3 agents completed",
      agents: [
        {
          displayName: "Explore",
          description: "Find cause",
          status: "completed",
          resultPreview: "Timer re-registers widget.",
          toolUses: 1,
          durationMs: 1200,
        },
        {
          displayName: "Plan",
          description: "Shape patch",
          status: "completed",
          resultPreview: "Extract pure renderer first.",
          toolUses: 2,
          durationMs: 2300,
        },
        {
          displayName: "Debug",
          description: "Verify",
          status: "completed",
          resultPreview: "Focused tests pass.",
          toolUses: 3,
          durationMs: 3400,
        },
      ],
    })).toMatchInlineSnapshot(`
      [
        "✓ 3 agents completed",
        "├─ ✓ Explore Find cause · 1 tool · 1.2s",
        "│  └─ Timer re-registers widget.",
        "├─ ✓ Plan Shape patch · 2 tools · 2.3s",
        "│  └─ Extract pure renderer first.",
        "└─ ✓ Debug Verify · 3 tools · 3.4s",
        "   └─ Focused tests pass.",
      ]
    `);
  });

  it("renders error status with error text and result preview", () => {
    expect(renderSubagentSummary({
      displayName: "Jintong",
      description: "Patch renderer",
      status: "error",
      error: "Typecheck failed\nunused import",
      resultPreview: "Stopped before writing files.",
      turnCount: 1,
      maxTurns: 3,
      toolUses: 1,
      durationMs: 300,
    })).toMatchInlineSnapshot(`
      [
        "✗ Jintong Patch renderer · ↻1≤3 · 1 tool · 0.3s · error: Typecheck failed",
        "└─ Stopped before writing files.",
      ]
    `);
  });

  it("renders recovered completion as a warning without masking real failures", () => {
    const recovered = renderSubagentSummary({
      displayName: "Review",
      description: "Recovered session",
      status: "completed",
      completionDisposition: "recovered",
    });
    const clean = renderSubagentSummary({
      displayName: "Review",
      status: "completed",
      completionDisposition: "clean",
    });

    expect(recovered[0]).toBe("⚠ recovered · Review Recovered session");
    expect(clean[0]).toBe("✓ Review");

    for (const status of ["error", "aborted"] as const) {
      const [line] = renderSubagentSummary({
        displayName: "Review",
        status,
        completionDisposition: "recovered",
      });
      expect(line).toMatch(/^✗ Review/);
      expect(line).not.toContain("recovered");
    }
  });

  it("preserves lifecycle icons for recovered non-completed records", () => {
    const cases = [
      { status: "running" as const, spinnerFrame: 2, expected: "⠹ Review · recovered" },
      { status: "queued" as const, expected: "◦ Review · recovered" },
      { status: "steered" as const, expected: "✓ Review · turn limit · recovered" },
      { status: "stopped" as const, expected: "■ Review · stopped · recovered" },
    ];

    for (const { status, spinnerFrame, expected } of cases) {
      const [line] = renderSubagentSummary({
        displayName: "Review",
        status,
        spinnerFrame,
        completionDisposition: "recovered",
      });
      expect(line).toBe(expected);
    }
  });

  it("keeps recovered warning output width-safe with Unicode and ANSI input", () => {
    const summary = {
      displayName: "修复🧰",
      description: "\u001b[31mrécovered session with a long diagnostic\u001b[0m",
      status: "completed" as const,
      completionDisposition: "recovered" as const,
    };

    for (const width of [8, 20, 40, 80, 120]) {
      const lines = renderSubagentSummary(summary, { width });
      for (const line of lines) {
        expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
      }
      if (width === 20 || width === 40) {
        expect(lines[0]).toContain("⚠ recovered");
      }
    }
    expect(renderSubagentSummary(summary, { width: 120 })[0]).toContain("⚠ recovered · 修复🧰");
  });

  it("truncates every rendered line to requested width", () => {
    const lines = renderSubagentSummary({
      title: "2 very long agents completed with details",
      agents: [
        {
          displayName: "Explore",
          description: "Inspect an extremely long description that should not overflow",
          status: "completed",
          resultPreview: "This preview is also intentionally long enough to require truncation.",
          totalTokens: 123_456,
          durationMs: 5700,
        },
        {
          displayName: "Plan",
          description: "Write narrow safe rendering",
          status: "error",
          error: "A very long error message that should be cut safely",
          resultPreview: "Error preview should be truncated too.",
          durationMs: 600,
        },
      ],
    }, { width: 32 });

    expect(lines).toMatchInlineSnapshot(`
      [
        "✗ 2 very long agents complete...",
        "├─ ✓ Explore Inspect an extre...",
        "│  └─ This preview is also in...",
        "└─ ✗ Plan Write narrow safe r...",
        "   └─ Error preview should be...",
      ]
    `);
    expect(lines.every(line => line.length <= 32)).toBe(true);
  });
});
