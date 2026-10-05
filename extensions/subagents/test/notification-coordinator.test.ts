import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentPresentation, createNotificationCoordinator } from "../src/notification-coordinator.js";
import type { AgentRecord } from "../src/types.js";

function record(id: string): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: id,
    status: "completed",
    result: `${id} done`,
    toolUses: 0,
    startedAt: 0,
    completedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
}

function presentation(): AgentPresentation {
  return {
    activity: new Map(),
    widget: { markFinished: vi.fn(), update: vi.fn() },
    fleet: { onAgentFinished: vi.fn() },
  } as unknown as AgentPresentation;
}

function setup(records: AgentRecord[]) {
  vi.useFakeTimers();
  const byId = new Map(records.map((agent) => [agent.id, agent]));
  const sendMessage = vi.fn();
  const ui = presentation();
  const coordinator = createNotificationCoordinator(
    { sendMessage } as unknown as ExtensionAPI,
    (id) => byId.get(id),
    ui,
  );
  return { coordinator, sendMessage, ui };
}

describe("notification coordinator parking", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["async", "smart"] as const)("retains the completed execution through %s parking and same-agent resume", (mode) => {
    const agent = { ...record("a1"), executionId: "old", turnCount: 7 };
    const peer = { ...record("b2"), executionId: "peer" };
    const { coordinator, sendMessage, ui } = setup([agent, peer]);
    ui.activity.set(agent.id, { activeTools: new Map(), toolUses: 4, turnCount: 7, responseText: "old partial", lifetimeUsage: agent.lifetimeUsage });
    coordinator.hold();
    coordinator.track(agent.id, mode);
    if (mode === "smart") coordinator.track(peer.id, mode);
    coordinator.onComplete(agent);
    // Resume before debounce/group completion; the old mutable record is reused.
    agent.executionId = "new";
    agent.status = "running";
    agent.turnCount = 8;
    agent.result = "new output";
    agent.completedAt = undefined;
    agent.resultConsumed = true;
    const active = { activeTools: new Map([["t", "bash"]]), toolUses: 5, turnCount: 8, responseText: "new output", lifetimeUsage: agent.lifetimeUsage };
    ui.activity.set(agent.id, active);
    vi.mocked(ui.widget.markFinished).mockClear();
    if (mode === "smart") coordinator.onComplete(peer);
    vi.advanceTimersByTime(300);
    coordinator.release();
    const messages = sendMessage.mock.calls.map(call => call[0]);
    const content = messages.map(message => message.content).join("\n");
    expect(content).toContain("a1 done");
    expect(content).not.toContain("new output");
    expect(JSON.stringify(messages)).toContain('"turnCount":7');
    expect(ui.activity.get(agent.id)).toBe(active);
    expect(ui.widget.markFinished).not.toHaveBeenCalledWith(agent.id);
  });

  it.each(["old", "new"] as const)("consuming %s cancels only that execution's nudge", (consumed) => {
    const agent = { ...record("a1"), executionId: "old" };
    const { coordinator, sendMessage } = setup([agent]);
    coordinator.hold();
    coordinator.onComplete(agent);
    agent.executionId = "new";
    agent.result = "new output";
    coordinator.onComplete(agent);
    coordinator.consume(agent.id, consumed);
    vi.advanceTimersByTime(200);
    coordinator.release();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0].content).toContain(consumed === "old" ? "new output" : "a1 done");
    expect(agent.resultConsumed).toBeUndefined();
  });

  it("counts a consumed old completion in its debounce group after resume", () => {
    const first = { ...record("a1"), executionId: "old" };
    const peer = { ...record("b2"), executionId: "peer" };
    const { coordinator, sendMessage } = setup([first, peer]);
    coordinator.track(first.id, "smart");
    coordinator.track(peer.id, "smart");
    coordinator.onComplete(first);
    coordinator.consume(first.id, "old");
    first.executionId = "new";
    first.status = "running";
    first.completedAt = undefined;
    coordinator.onComplete(peer);
    vi.advanceTimersByTime(300);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("b2 done");
    expect(sendMessage.mock.calls[0]?.[0].content).not.toContain("a1 done");
  });

  it.each(["user", "supervisor-idle", "supervisor-ceiling", "unknown"] as const)("captures %s interruption provenance before resume", (cause) => {
    const agent: AgentRecord = { ...record("a1"), executionId: "old", status: "stopped", interruptionCause: cause };
    const { coordinator, sendMessage } = setup([agent]);
    coordinator.hold();
    coordinator.onComplete(agent);
    agent.executionId = "new";
    agent.interruptionCause = undefined;
    agent.status = "running";
    vi.advanceTimersByTime(200);
    coordinator.release();
    const message = sendMessage.mock.calls[0]?.[0];
    expect(message.details.interruptionCause).toBe(cause);
    expect(message.content.includes("STOPPED BY THE USER")).toBe(cause === "user");
    expect(message.content).toContain("NOT finished");
  });

  it("sends after 200ms when not holding", () => {
    const agent = record("a1");
    const { coordinator, sendMessage } = setup([agent]);
    coordinator.onComplete(agent);
    vi.advanceTimersByTime(199);
    expect(sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("<task-id>a1</task-id>");
  });

  it("drops a consumed parked nudge on release", () => {
    const agent = record("a1");
    const { coordinator, sendMessage } = setup([agent]);
    coordinator.hold();
    coordinator.onComplete(agent);
    vi.advanceTimersByTime(200);
    agent.resultConsumed = true;
    coordinator.cancel(agent.id);
    coordinator.release();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends a parked nudge once on release", () => {
    const agent = record("a1");
    const { coordinator, sendMessage } = setup([agent]);
    coordinator.hold();
    coordinator.onComplete(agent);
    vi.advanceTimersByTime(200);
    expect(sendMessage).not.toHaveBeenCalled();
    coordinator.release();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
    coordinator.release();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends only unconsumed members of a parked smart group", () => {
    const first = record("a1");
    const second = record("b2");
    const { coordinator, sendMessage } = setup([first, second]);
    coordinator.hold();
    coordinator.track(first.id, "smart");
    coordinator.track(second.id, "smart");
    coordinator.onComplete(first);
    coordinator.onComplete(second);
    vi.advanceTimersByTime(300);
    first.resultConsumed = true;
    coordinator.release();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const content = String(sendMessage.mock.calls[0]?.[0].content);
    expect(content).toContain("<task-id>b2</task-id>");
    expect(content).not.toContain("<task-id>a1</task-id>");
  });

  it("sends nothing when every grouped result was consumed", () => {
    const first = record("a1");
    const second = record("b2");
    const { coordinator, sendMessage } = setup([first, second]);
    coordinator.hold();
    coordinator.track(first.id, "smart");
    coordinator.track(second.id, "smart");
    coordinator.onComplete(first);
    coordinator.onComplete(second);
    vi.advanceTimersByTime(300);
    first.resultConsumed = true;
    second.resultConsumed = true;
    coordinator.release();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps parked sends when release does not flush", () => {
    const agent = record("a1");
    const { coordinator, sendMessage } = setup([agent]);
    coordinator.hold();
    coordinator.onComplete(agent);
    vi.advanceTimersByTime(200);
    coordinator.release(false);
    expect(sendMessage).not.toHaveBeenCalled();
    coordinator.release();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("<task-id>a1</task-id>");
  });

  it("clearPending drops parked sends and resumes direct delivery", () => {
    const agent = record("a1");
    const { coordinator, sendMessage } = setup([agent]);
    coordinator.hold();
    coordinator.onComplete(agent);
    vi.advanceTimersByTime(200);
    coordinator.clearPending();
    coordinator.release();
    expect(sendMessage).not.toHaveBeenCalled();
    coordinator.onComplete(agent);
    vi.advanceTimersByTime(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
