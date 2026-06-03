// Phase 1.1b red→green; do not skip
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_STALE_ABORT_AFTER_MS,
  BACKGROUND_SUPERVISION_COOLDOWN_MS,
  DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS,
  emitSupervisionAbortWarning,
  getBackgroundSupervisionAction,
} from "../../src/background-supervision.js";

function readPandaWarn(spy: ReturnType<typeof vi.spyOn>) {
  const line = spy.mock.calls[0]?.[0];
  expect(line).toBeTypeOf("string");
  expect(line).toMatch(/^\[panda-warn\] /);
  return JSON.parse((line as string).slice("[panda-warn] ".length)) as Record<string, unknown>;
}

describe("regression: supervision non-streaming re-detect", () => {
  const now = BACKGROUND_STALE_ABORT_AFTER_MS + 1;
  const lastSupervisionSteerAt = now - BACKGROUND_SUPERVISION_COOLDOWN_MS + 1_000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks a token-idle abort as suppressed when no streaming deltas were seen", () => {
    const result = getBackgroundSupervisionAction({
      record: {
        status: "running",
        isBackground: true,
        startedAt: 0,
        lastSupervisionSteerAt,
      },
      activity: { lastProgressAt: 0, streamingDeltasSeen: false },
      now,
      ceilingMs: DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS,
    });

    expect(result.action).toBe("none");
    expect(result.reasonClass).toBe("non-stream-disabled");
    expect(result.markNonStreaming).toBe(true);
  });

  it("clears the non-streaming suppression path after streaming deltas later appear", () => {
    const result = getBackgroundSupervisionAction({
      record: {
        status: "running",
        isBackground: true,
        startedAt: 0,
        lastSupervisionSteerAt,
      },
      activity: {
        lastProgressAt: 0,
        streamingDeltasSeen: true,
        nonStreamingSince: BACKGROUND_STALE_ABORT_AFTER_MS,
      },
      now,
      ceilingMs: DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS,
    });

    expect(result.action).toBe("abort");
    expect(result.markNonStreaming).toBeUndefined();
  });

  it("emits structured abort warning for non-stream-disabled suppression", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    emitSupervisionAbortWarning({ agentId: "agent-2", idleMs: now, reasonClass: "non-stream-disabled" });

    expect(readPandaWarn(warn)).toMatchObject({
      code: "subagent.supervision.abort",
      agentId: "agent-2",
      idleMs: now,
      reasonClass: "non-stream-disabled",
    });
    expect(readPandaWarn(warn).ts).toBeTypeOf("string");
  });
});
