/**
 * terminal-contract-parity.test.ts — characterization oracle for the subagent terminal contract.
 *
 * Locks CURRENT behavior of all 5 terminal families as a green baseline.
 * Every future write-path migration (AgentRun as writer, projector, etc.) MUST keep this green.
 *
 * Tests through the existing seams: emitTerminalContract + buildSubagentRecordEntry.
 * No production-code changes. No real agents spawned.
 *
 * Families covered:
 *   completed · steered · failed/error · aborted (max_turns) · stopped (user)
 *
 * Per family asserts:
 *   (a) emitted subagents:* event name + payload
 *   (b) durable subagents:record entry — exact field values via buildSubagentRecordEntry
 *   (c) AgentRecord terminal fields: status / result / error / startedAt / completedAt
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildSubagentRecordEntry,
  emitTerminalContract,
} from "../../src/external-contract-adapter.js";
import type { AgentRecord } from "../../src/types.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function spyPi() {
  return {
    events: { emit: vi.fn() },
    appendEntry: vi.fn(),
  };
}

/**
 * Fully-populated background record.  Override only the fields that differ per family.
 * Fields common to all families (id, type, sessionFile, etc.) are fixed so the oracle
 * captures exact values — not just shapes.
 */
function makeRecord(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: "agent-42",
    type: "general-purpose",
    description: "parity oracle agent",
    status: "completed",
    toolUses: 7,
    startedAt: 1_000_000,
    completedAt: 2_000_000,
    isBackground: true,
    parentSessionId: "session-parent",
    sessionDir: "/tmp/subagent-sessions/agent-42",
    sessionFile: "/tmp/subagent-sessions/agent-42/session.jsonl",
    outputFile: "/tmp/subagent-sessions/agent-42/output.txt",
    toolCallId: "toolu_parity_abc",
    modelLabel: "anthropic/claude-sonnet-4-6",
    ...overrides,
  } as AgentRecord;
}

/** Snapshot of the live event data passed by supervision.ts — opaque to the adapter. */
const EVENT_DATA = { id: "agent-42", status: "x", tokens: "1k" };

// ─── shared expected record entry (fields constant across families) ────────────

const COMMON_ENTRY = {
  id: "agent-42",
  type: "general-purpose",
  description: "parity oracle agent",
  startedAt: 1_000_000,
  completedAt: 2_000_000,
  outputFile: "/tmp/subagent-sessions/agent-42/output.txt",
  sessionFile: "/tmp/subagent-sessions/agent-42/session.jsonl",
  sessionDir: "/tmp/subagent-sessions/agent-42",
  parentSessionId: "session-parent",
  toolCallId: "toolu_parity_abc",
  modelLabel: "anthropic/claude-sonnet-4-6",
};

// ─── family 1: completed ───────────────────────────────────────────────────────

describe("terminal contract parity — completed", () => {
  const record = makeRecord({ status: "completed", result: "task finished", error: undefined });

  it("(a) emits subagents:completed with event data", () => {
    const pi = spyPi();
    emitTerminalContract(pi, record, EVENT_DATA);
    expect(pi.events.emit).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:completed", EVENT_DATA);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1); // guard: no double-emission
  });

  it("(b) record entry exact field values", () => {
    const entry = buildSubagentRecordEntry(record);
    expect(entry).toEqual({
      ...COMMON_ENTRY,
      status: "completed",
      result: "task finished",
      error: undefined,
    });
  });

  it("(c) AgentRecord terminal fields", () => {
    expect(record.status).toBe("completed");
    expect(record.result).toBe("task finished");
    expect(record.error).toBeUndefined();
    expect(record.startedAt).toBe(1_000_000);
    expect(record.completedAt).toBe(2_000_000);
  });
});

// ─── family 2: steered ────────────────────────────────────────────────────────

describe("terminal contract parity — steered", () => {
  const record = makeRecord({ status: "steered", result: "partial result", error: undefined });

  it("(a) emits subagents:completed (same channel as completed)", () => {
    const pi = spyPi();
    emitTerminalContract(pi, record, EVENT_DATA);
    expect(pi.events.emit).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:completed", EVENT_DATA);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("(b) record entry exact field values", () => {
    const entry = buildSubagentRecordEntry(record);
    expect(entry).toEqual({
      ...COMMON_ENTRY,
      status: "steered",
      result: "partial result",
      error: undefined,
    });
  });

  it("(c) AgentRecord terminal fields", () => {
    expect(record.status).toBe("steered");
    expect(record.result).toBe("partial result");
    expect(record.error).toBeUndefined();
    expect(record.startedAt).toBe(1_000_000);
    expect(record.completedAt).toBe(2_000_000);
  });
});

// ─── family 3: failed / error ─────────────────────────────────────────────────

describe("terminal contract parity — failed/error", () => {
  const record = makeRecord({
    status: "error",
    result: undefined,
    error: "tool call failed with status 500",
  });

  it("(a) emits subagents:failed with event data", () => {
    const pi = spyPi();
    emitTerminalContract(pi, record, EVENT_DATA);
    expect(pi.events.emit).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:failed", EVENT_DATA);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("(b) record entry exact field values", () => {
    const entry = buildSubagentRecordEntry(record);
    expect(entry).toEqual({
      ...COMMON_ENTRY,
      status: "error",
      result: undefined,
      error: "tool call failed with status 500",
    });
  });

  it("(c) AgentRecord terminal fields", () => {
    expect(record.status).toBe("error");
    expect(record.result).toBeUndefined();
    expect(record.error).toBe("tool call failed with status 500");
    expect(record.startedAt).toBe(1_000_000);
    expect(record.completedAt).toBe(2_000_000);
  });
});

// ─── family 4: aborted (max_turns) ────────────────────────────────────────────

describe("terminal contract parity — aborted (max_turns)", () => {
  // NOTE (future parity gate): aborted currently carries no error field.
  // Candidate slice 3 may add error?:string here — that change must update this block.
  const record = makeRecord({ status: "aborted", result: undefined, error: undefined });

  it("(a) emits subagents:failed (aborted routes to failed channel)", () => {
    const pi = spyPi();
    emitTerminalContract(pi, record, EVENT_DATA);
    expect(pi.events.emit).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:failed", EVENT_DATA);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("(b) record entry exact field values — error field absent/undefined", () => {
    const entry = buildSubagentRecordEntry(record);
    expect(entry).toEqual({
      ...COMMON_ENTRY,
      status: "aborted",
      result: undefined,
      error: undefined,
    });
  });

  it("(c) AgentRecord terminal fields", () => {
    expect(record.status).toBe("aborted");
    expect(record.result).toBeUndefined();
    expect(record.error).toBeUndefined();
    expect(record.startedAt).toBe(1_000_000);
    expect(record.completedAt).toBe(2_000_000);
  });
});

// ─── family 5: stopped (user) ─────────────────────────────────────────────────

describe("terminal contract parity — stopped (user)", () => {
  const record = makeRecord({ status: "stopped", result: undefined, error: "Agent was stopped while running." });

  it("(a) emits subagents:failed (user-stopped routes to failed channel)", () => {
    const pi = spyPi();
    emitTerminalContract(pi, record, EVENT_DATA);
    expect(pi.events.emit).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:failed", EVENT_DATA);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("(b) record entry exact field values — stop message preserved in error", () => {
    const entry = buildSubagentRecordEntry(record);
    expect(entry).toEqual({
      ...COMMON_ENTRY,
      status: "stopped",
      result: undefined,
      error: "Agent was stopped while running.",
    });
  });

  it("(c) AgentRecord terminal fields", () => {
    expect(record.status).toBe("stopped");
    expect(record.result).toBeUndefined();
    expect(record.error).toBe("Agent was stopped while running.");
    expect(record.startedAt).toBe(1_000_000);
    expect(record.completedAt).toBe(2_000_000);
  });
});

// ─── cross-family invariants ──────────────────────────────────────────────────

describe("terminal contract parity — cross-family invariants", () => {
  it("every terminal family emits exactly 1 event + 1 record (no double-emission)", () => {
    const families: Array<AgentRecord["status"]> = [
      "completed",
      "steered",
      "error",
      "aborted",
      "stopped",
    ];
    for (const status of families) {
      const pi = spyPi();
      emitTerminalContract(pi, makeRecord({ status }), EVENT_DATA);
      expect(pi.events.emit).toHaveBeenCalledTimes(1);
      expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    }
  });

  it("completed + steered emit subagents:completed; error + aborted + stopped emit subagents:failed", () => {
    const completedChannel = ["completed", "steered"] as const;
    const failedChannel = ["error", "aborted", "stopped"] as const;
    for (const status of completedChannel) {
      const pi = spyPi();
      emitTerminalContract(pi, makeRecord({ status }), EVENT_DATA);
      expect(pi.events.emit).toHaveBeenCalledWith("subagents:completed", EVENT_DATA);
    }
    for (const status of failedChannel) {
      const pi = spyPi();
      emitTerminalContract(pi, makeRecord({ status }), EVENT_DATA);
      expect(pi.events.emit).toHaveBeenCalledWith("subagents:failed", EVENT_DATA);
    }
  });

  it("foreground runs (isBackground=false) emit nothing across all families", () => {
    const families: Array<AgentRecord["status"]> = [
      "completed",
      "steered",
      "error",
      "aborted",
      "stopped",
    ];
    for (const status of families) {
      const pi = spyPi();
      emitTerminalContract(pi, makeRecord({ status, isBackground: false }), EVENT_DATA);
      expect(pi.events.emit).not.toHaveBeenCalled();
      expect(pi.appendEntry).not.toHaveBeenCalled();
    }
  });

  it("appendEntry is always called with key 'subagents:record' for every terminal family", () => {
    const families: Array<AgentRecord["status"]> = [
      "completed",
      "steered",
      "error",
      "aborted",
      "stopped",
    ];
    for (const status of families) {
      const pi = spyPi();
      emitTerminalContract(pi, makeRecord({ status }), EVENT_DATA);
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "subagents:record",
        expect.objectContaining({ id: "agent-42", status }),
      );
    }
  });
});
