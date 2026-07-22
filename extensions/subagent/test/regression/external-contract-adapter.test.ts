// Phase 2a — locks the frozen external contract (audit gaps #1 emission rule + #3
// record field set) now that emission is extracted into a single tested adapter.
// Asserts behavior-equivalence with the prior inline supervision.ts emission.
import { describe, expect, it, vi } from "vitest";
import { SUBAGENTS_COMPLETED, SUBAGENTS_FAILED } from "../../../lib/subagent-channels.js";
import { appendTerminalCompatibilityRecord, buildSubagentRecordEntry, emitTerminalContract } from "../../src/external-contract-adapter.js";
import type { AgentRecord } from "../../src/types.js";

function bgRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "d",
    status: "completed",
    toolUses: 0,
    startedAt: 1000,
    isBackground: true,
    ...overrides,
  } as AgentRecord;
}

function spyPi() {
  return {
    events: { emit: vi.fn() },
    appendEntry: vi.fn(),
  };
}

const EVENT_DATA = { id: "a1", status: "x" };

describe("emitTerminalContract — channel mapping (background)", () => {
  // The prior inline rule: isError = status ∈ {error,stopped,aborted} → subagents:failed,
  // else subagents:completed; appendEntry on every terminal.
  const cases: Array<[AgentRecord["status"], typeof SUBAGENTS_COMPLETED | typeof SUBAGENTS_FAILED]> = [
    ["completed", SUBAGENTS_COMPLETED],
    ["steered", SUBAGENTS_COMPLETED],
    ["error", SUBAGENTS_FAILED],
    ["stopped", SUBAGENTS_FAILED],
    ["aborted", SUBAGENTS_FAILED],
  ];

  for (const [status, channel] of cases) {
    it(`status '${status}' → ${channel} (+ subagents:record)`, () => {
      const pi = spyPi();
      emitTerminalContract(pi, bgRecord({ status }), EVENT_DATA);
      expect(pi.events.emit).toHaveBeenCalledTimes(1);
      expect(pi.events.emit).toHaveBeenCalledWith(channel, EVENT_DATA);
      expect(pi.appendEntry).toHaveBeenCalledTimes(1);
      expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({ id: "a1", status }));
    });
  }

  it("non-terminal statuses emit nothing", () => {
    for (const status of ["queued", "running"] as const) {
      const pi = spyPi();
      emitTerminalContract(pi, bgRecord({ status }), EVENT_DATA);
      expect(pi.events.emit).not.toHaveBeenCalled();
      expect(pi.appendEntry).not.toHaveBeenCalled();
    }
  });
});

describe("emitTerminalContract — background gating", () => {
  it("foreground terminal runs emit nothing (terminal contract is background-only)", () => {
    const pi = spyPi();
    emitTerminalContract(pi, bgRecord({ status: "completed", isBackground: false }), EVENT_DATA);
    expect(pi.events.emit).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("undefined isBackground is treated as foreground (no emission)", () => {
    const pi = spyPi();
    emitTerminalContract(pi, bgRecord({ status: "completed", isBackground: undefined }), EVENT_DATA);
    expect(pi.events.emit).not.toHaveBeenCalled();
  });
});

describe("buildSubagentRecordEntry — exact durable field set", () => {
  it("includes precisely the verified keys", () => {
    const record = bgRecord({
      status: "completed",
      result: "r",
      error: undefined,
      completedAt: 2000,
      outputFile: "/o",
      sessionFile: "/s.jsonl",
      sessionDir: "/d",
      parentSessionId: "parent",
      toolCallId: "tc",
      modelLabel: "anthropic/claude-sonnet-4-6",
    });
    const entry = buildSubagentRecordEntry(record);
    expect(Object.keys(entry).sort()).toEqual(
      [
        "completedAt",
        "description",
        "error",
        "id",
        "modelLabel",
        "outputFile",
        "parentSessionId",
        "result",
        "sessionDir",
        "sessionFile",
        "startedAt",
        "status",
        "toolCallId",
        "type",
      ].sort(),
    );
    expect(entry.id).toBe("a1");
    expect(entry.status).toBe("completed");
    expect(entry.result).toBe("r");
    expect(entry.modelLabel).toBe("anthropic/claude-sonnet-4-6");
  });
});

describe("terminal durability ordering and repair", () => {
  it("appends compatibility history before the advisory event", async () => {
    const order: string[] = [];
    const pi = {
      appendEntry: vi.fn(async () => { order.push("record"); }),
      events: { emit: vi.fn(() => { order.push("event"); }) },
    };

    await emitTerminalContract(pi, bgRecord(), EVENT_DATA);

    expect(order).toEqual(["record", "event"]);
  });

  it("suppresses the advisory event when compatibility append fails", async () => {
    const pi = {
      appendEntry: vi.fn().mockRejectedValue(new Error("disk full")),
      events: { emit: vi.fn() },
    };

    await expect(emitTerminalContract(pi, bgRecord(), EVENT_DATA)).rejects.toThrow("disk full");
    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  it("keeps compatibility history durable when advisory event emission fails", async () => {
    const pi = {
      appendEntry: vi.fn().mockResolvedValue(undefined),
      events: { emit: vi.fn(() => { throw new Error("listener failed"); }) },
    };

    await expect(emitTerminalContract(pi, bgRecord(), EVENT_DATA)).rejects.toThrow("listener failed");
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "subagents:record",
      expect.objectContaining({ id: "a1", status: "completed" }),
    );
  });

  it("repairs compatibility history without replaying a historical lifecycle event", async () => {
    const pi = spyPi();

    await appendTerminalCompatibilityRecord(pi, bgRecord());

    expect(pi.appendEntry).toHaveBeenCalledWith(
      "subagents:record",
      expect.objectContaining({ id: "a1", status: "completed" }),
    );
    expect(pi.events.emit).not.toHaveBeenCalled();
  });
});
