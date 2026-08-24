import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  renderSubagentSummary,
  renderSubagentSummaryGroup,
  SUMMARY_SPINNER,
} from "../src/ui/summary-renderer.js";

describe("renderSubagentSummary", () => {
  it("renders a completed agent with the current compact stats and result preview", () => {
    expect(renderSubagentSummary({
      displayName: "Chengfeng",
      description: "Audit renderer",
      status: "completed",
      modelName: "sonnet",
      tags: ["thinking: high", "isolated"],
      turnCount: 4,
      maxTurns: 20,
      compactionCount: 2,
      toolUses: 3,
      totalTokens: 12_345,
      durationMs: 65_000,
      resultPreview: "Found the rendering gap.\nAdditional detail",
    })).toEqual([
      "✓ Chengfeng Audit renderer · sonnet · thinking: high · isolated · ↻4≤20 · ⇲2 · 3 tools · 12.3k · 1m5s",
      "└─ Found the rendering gap.",
    ]);
  });

  it("renders running activity and queued/background placeholders", () => {
    expect(renderSubagentSummary({
      displayName: "Jintong",
      status: "running",
      spinnerFrame: 1,
      activity: "Running focused tests\nthen typecheck",
    })).toEqual([`${SUMMARY_SPINNER[1]} Jintong`, "└─ Running focused tests"]);

    expect(renderSubagentSummary({
      displayName: "Wenchang",
      status: "queued",
      activity: "Waiting for a slot",
    })).toEqual(["◦ Wenchang", "└─ Waiting for a slot"]);

    expect(renderSubagentSummary({
      displayName: "Guangguang",
      status: "background",
    })).toEqual(["○ Guangguang", "└─ thinking…"]);
  });

  it.each([
    ["steered", "✓ Jintong · turn limit"],
    ["stopped", "■ Jintong · stopped"],
    ["aborted", "✗ Jintong · aborted"],
    ["error", "✗ Jintong · error: process exited 1"],
  ] as const)("renders %s status vocabulary", (status, expected) => {
    expect(renderSubagentSummary({
      displayName: "Jintong",
      status,
      error: status === "error" ? "process exited 1\nstack omitted" : undefined,
    })).toEqual([expected]);
  });

  it("omits zero and unavailable stats", () => {
    expect(renderSubagentSummary({
      displayName: "Jintong",
      status: "completed",
      turnCount: 0,
      compactionCount: 0,
      toolUses: 0,
      totalTokens: 0,
      durationMs: 0,
      tokens: "",
      tags: [],
    })).toEqual(["✓ Jintong"]);
  });

  it("renders grouped agents in order with continuous tree connectors", () => {
    expect(renderSubagentSummaryGroup({
      title: "Review group",
      agents: [
        {
          displayName: "Chengfeng",
          description: "First",
          status: "completed",
          resultPreview: "one",
        },
        {
          displayName: "Wenchang",
          description: "Second",
          status: "queued",
          activity: "waiting",
        },
        {
          displayName: "Jintong",
          description: "Third",
          status: "error",
          error: "boom",
          resultPreview: "three",
        },
      ],
    })).toEqual([
      `${SUMMARY_SPINNER[0]} Review group`,
      "├─ ✓ Chengfeng First",
      "│  └─ one",
      "├─ ◦ Wenchang Second",
      "│  └─ waiting",
      "└─ ✗ Jintong Third · error: boom",
      "   └─ three",
    ]);
  });

  it("keeps ANSI, CJK, emoji, combining text, and long values width-safe", () => {
    const widths = [0, 1, 2, 8, 20, 40, 80, 120];
    const input = {
      displayName: "\u001b[35m金童\u001b[0m",
      description: "修复🧪 e\u0301 " + "https://example.test/" + "a".repeat(180),
      status: "completed" as const,
      modelName: "模型🚀",
      tags: ["thinking: 超高", "tag-e\u0301"],
      turnCount: 12,
      maxTurns: 30,
      compactionCount: 3,
      toolUses: 17,
      totalTokens: 1_234_567,
      durationMs: 3_723_000,
      resultPreview: "\u001b[31m结果🧩 e\u0301\u001b[0m " + "界".repeat(100),
    };

    for (const width of widths) {
      const lines = renderSubagentSummary(input, { width });
      expect(lines.length).toBe(2);
      for (const line of lines) {
        expect(visibleWidth(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
      }
      if (width === 0) expect(lines).toEqual(["", ""]);
    }
  });
});