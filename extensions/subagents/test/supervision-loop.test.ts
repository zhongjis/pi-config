import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_SUPERVISION_INTERVAL_MS } from "../src/background-supervision.js";
import {
  AUTO_STEER_MESSAGE,
  type SupervisionManager,
  startBackgroundSupervision,
} from "../src/supervision-loop.js";
import type { AgentRecord } from "../src/types.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";

const mockPi = {} as unknown as ExtensionAPI;

function makeRecord(startedAt: number): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "worker",
    status: "running",
    toolUses: 0,
    startedAt,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    isBackground: true,
  };
}

function makeActivity(lastProgressAt: number, activeToolCount = 0): AgentActivity {
  const activeTools = new Map<string, string>();
  for (let i = 0; i < activeToolCount; i++) activeTools.set(`t${i}`, "bash");
  return {
    activeTools,
    toolUses: 0,
    responseText: "",
    turnCount: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    lastProgressAt,
  };
}

describe("startBackgroundSupervision", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("steers a stale idle background agent once and stamps lastSupervisionSteerAt", () => {
    const base = Date.now();
    const record = makeRecord(base - 3 * 60_000);
    const activity = makeActivity(base - 3 * 60_000);
    const steer = vi.fn(() => true);
    const abort = vi.fn(() => true);
    const manager: SupervisionManager = {
      getRunning: () => [record],
      steer,
      abort,
    };
    const agentActivity = new Map([[record.id, activity]]);

    const stop = startBackgroundSupervision(mockPi, manager, agentActivity);
    vi.advanceTimersByTime(BACKGROUND_SUPERVISION_INTERVAL_MS);

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(record.id, AUTO_STEER_MESSAGE);
    expect(abort).not.toHaveBeenCalled();
    expect(record.lastSupervisionSteerAt).toBeDefined();

    stop();
  });

  it("does nothing when the agent recently made progress", () => {
    const base = Date.now();
    const record = makeRecord(base - 10_000);
    const activity = makeActivity(base); // fresh progress
    const steer = vi.fn(() => true);
    const abort = vi.fn(() => true);
    const manager: SupervisionManager = {
      getRunning: () => [record],
      steer,
      abort,
    };
    const agentActivity = new Map([[record.id, activity]]);

    const stop = startBackgroundSupervision(mockPi, manager, agentActivity);
    vi.advanceTimersByTime(BACKGROUND_SUPERVISION_INTERVAL_MS);

    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(record.lastSupervisionSteerAt).toBeUndefined();
    expect(record.lastSupervisionAbortAt).toBeUndefined();

    stop();
  });

  it("stop() clears the interval so no further ticks fire", () => {
    const base = Date.now();
    const record = makeRecord(base - 3 * 60_000);
    const activity = makeActivity(base - 3 * 60_000);
    const steer = vi.fn(() => true);
    const manager: SupervisionManager = {
      getRunning: () => [record],
      steer,
      abort: vi.fn(() => true),
    };
    const agentActivity = new Map([[record.id, activity]]);

    const stop = startBackgroundSupervision(mockPi, manager, agentActivity);
    stop();
    vi.advanceTimersByTime(BACKGROUND_SUPERVISION_INTERVAL_MS * 3);

    expect(steer).not.toHaveBeenCalled();
  });
});
