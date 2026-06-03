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
        "⠹ Explore Trace blinking · sonnet·⟳ 3≤12·󱁤 4·󰾆 12.3k·5.7s",
        "  ⎿ reading files…",
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
      tokens: "󰾆 9.8k",
      durationMs: 12_400,
    })).toMatchInlineSnapshot(`
      [
        "✓ Plan Draft fix · ⟳ 5·󱁤 2·󰾆 9.8k·12.4s",
        "  ⎿ Use stable widget callback and requestRender.",
      ]
    `);
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
        "├─ ✓ Explore Find cause · 󱁤 1·1.2s",
        "│    ⎿ Timer re-registers widget.",
        "├─ ✓ Plan Shape patch · 󱁤 2·2.3s",
        "│    ⎿ Extract pure renderer first.",
        "└─ ✓ Debug Verify · 󱁤 3·3.4s",
        "     ⎿ Focused tests pass.",
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
        "✗ Jintong Patch renderer · ⟳ 1≤3·󱁤 1·0.3s · error: Typecheck failed",
        "  ⎿ Stopped before writing files.",
      ]
    `);
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
        "│    ⎿ This preview is also i...",
        "└─ ✗ Plan Write narrow safe r...",
        "     ⎿ Error preview should b...",
      ]
    `);
    expect(lines.every(line => line.length <= 32)).toBe(true);
  });
});
