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
  const coordinator = createNotificationCoordinator(
    { sendMessage } as unknown as ExtensionAPI,
    (id) => byId.get(id),
    presentation(),
  );
  return { coordinator, sendMessage };
}

describe("notification coordinator parking", () => {
  afterEach(() => {
    vi.useRealTimers();
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
