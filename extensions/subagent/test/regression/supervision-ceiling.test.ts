// Phase 1.1b red→green; do not skip
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS,
  emitSupervisionAbortWarning,
  emitSupervisionCeilingHitWarning,
  getBackgroundSupervisionAction,
  parseSubagentSupervisionCeilingMs,
} from "../../src/background-supervision.js";

function readPandaWarn(spy: ReturnType<typeof vi.spyOn>, callIndex = 0) {
  const [prefix, line] = spy.mock.calls[callIndex] ?? [];
  expect(prefix).toBe("[panda-warn]");
  expect(line).toBeTypeOf("string");
  return JSON.parse(line as string) as Record<string, unknown>;
}

describe("regression: supervision absolute ceiling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("defaults the absolute ceiling to exactly 30 minutes", () => {
    vi.stubEnv("SUBAGENT_SUPERVISION_CEILING_MS", "");

    expect(DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS).toBe(30 * 60_000);
    expect(parseSubagentSupervisionCeilingMs()).toBe(30 * 60_000);
  });

  it("uses a valid env override for the absolute ceiling", () => {
    vi.stubEnv("SUBAGENT_SUPERVISION_CEILING_MS", "12345");

    expect(parseSubagentSupervisionCeilingMs()).toBe(12_345);
  });

  it("falls back to the default ceiling for invalid env values", () => {
    vi.stubEnv("SUBAGENT_SUPERVISION_CEILING_MS", "not-a-number");

    expect(parseSubagentSupervisionCeilingMs()).toBe(DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS);
  });

  it("aborts at the ceiling even while active tools would suppress token-idle", () => {
    const now = 10_000;

    const result = getBackgroundSupervisionAction({
      record: { status: "running", isBackground: true, startedAt: 0 },
      activity: {
        lastProgressAt: 0,
        activeTools: new Map([["bash_1", "bash"]]),
        streamingDeltasSeen: false,
      },
      now,
      ceilingMs: now,
    });

    expect(result.action).toBe("abort");
    expect(result.reasonClass).toBe("ceiling");
  });

  it("aborts at the ceiling even while non-streaming detection would suppress token-idle", () => {
    const now = 10_000;

    const result = getBackgroundSupervisionAction({
      record: { status: "running", isBackground: true, startedAt: 0 },
      activity: { lastProgressAt: 0, streamingDeltasSeen: false },
      now,
      ceilingMs: now,
    });

    expect(result.action).toBe("abort");
    expect(result.reasonClass).toBe("ceiling");
  });

  it("emits structured warning codes when the absolute ceiling triggers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    emitSupervisionCeilingHitWarning({ agentId: "agent-1", idleMs: 10_000, ceilingMs: 10_000 });
    emitSupervisionAbortWarning({ agentId: "agent-1", idleMs: 10_000, reasonClass: "ceiling" });

    expect(readPandaWarn(warn, 0)).toMatchObject({
      code: "subagent.supervision.ceiling-hit",
      agentId: "agent-1",
      idleMs: 10_000,
      ceilingMs: 10_000,
    });
    expect(readPandaWarn(warn, 1)).toMatchObject({
      code: "subagent.supervision.abort",
      agentId: "agent-1",
      idleMs: 10_000,
      reasonClass: "ceiling",
    });
    expect(readPandaWarn(warn, 0).ts).toBeTypeOf("number");
    expect(readPandaWarn(warn, 1).ts).toBeTypeOf("number");
  });
});
