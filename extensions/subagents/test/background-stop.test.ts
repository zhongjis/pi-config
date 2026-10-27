import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_STOP_WINDOW_MS, createBackgroundStop } from "../src/background-stop.js";
import { createGraphRunTask } from "../src/graph/task.js";
import type { AgentRecord } from "../src/types.js";

const ESC = "\x1b";

function agent(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id, type: "fixture", description: id, status: "running", toolUses: 0, startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0, ...extra,
  };
}

function setup(agents: AgentRecord[], graphStatus: "running" | "completed" = "running") {
  let time = 1_000;
  const graph = createGraphRunTask({ id: "agr_1", script: "" });
  graph.status = graphStatus;
  const abortAgent = vi.fn();
  const stop = createBackgroundStop({ listAgents: () => agents, abortAgent, graphRuns: () => [graph], now: () => time });
  let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const ui = { notify: vi.fn(), onTerminalInput: vi.fn((h: typeof handler) => { handler = h; return () => { handler = undefined; }; }) };
  let idle = true;
  stop.listen(ui as never, () => idle);
  return {
    stop, ui, graph, abortAgent,
    press: (data = ESC) => handler?.(data),
    advance: (ms: number) => { time += ms; },
    busy: () => { idle = false; },
  };
}

describe("second Esc stops background work", () => {
  it("stops top-level background agents and running graph runs as a user stop", () => {
    const t = setup([
      agent("bg"),
      agent("queued", { status: "queued" }),
      agent("done", { status: "completed" }),
      agent("graph-owned", { graphRunId: "agr_1" }),
      agent("nested", { parentAgentId: "bg" }),
    ]);
    t.stop.arm(t.ui);
    expect(t.ui.notify).toHaveBeenLastCalledWith("Press Esc again to stop 2 background agents and 1 agent graph run.", "warning");
    expect(t.press()).toEqual({ consume: true });
    expect(t.abortAgent.mock.calls.map(call => call[0])).toEqual(["bg", "queued"]);
    expect(t.graph.abortController.signal.reason).toBe("user");
    expect(t.ui.notify).toHaveBeenLastCalledWith("Stopped 2 background agents and 1 agent graph run.", "info");
    // One shot: a third Esc goes back to Pi.
    expect(t.press()).toBeUndefined();
  });

  it("leaves Esc to Pi when nothing runs, the window expired, the turn restarted, or the session is busy", () => {
    const empty = setup([agent("done", { status: "completed" })], "completed");
    empty.stop.arm(empty.ui);
    expect(empty.ui.notify).not.toHaveBeenCalled();
    expect(empty.press()).toBeUndefined();

    const expired = setup([agent("bg")]);
    expired.stop.arm(expired.ui);
    expired.advance(BACKGROUND_STOP_WINDOW_MS + 1);
    expect(expired.press()).toBeUndefined();
    expect(expired.abortAgent).not.toHaveBeenCalled();

    const restarted = setup([agent("bg")]);
    restarted.stop.arm(restarted.ui);
    restarted.stop.disarm();
    expect(restarted.press()).toBeUndefined();

    const busy = setup([agent("bg")]);
    busy.stop.arm(busy.ui);
    busy.busy();
    expect(busy.press()).toBeUndefined();
    expect(busy.abortAgent).not.toHaveBeenCalled();
  });

  it("ignores other keys and keeps the window armed for Esc", () => {
    const t = setup([agent("bg")]);
    t.stop.arm(t.ui);
    expect(t.press("a")).toBeUndefined();
    expect(t.press()).toEqual({ consume: true });
    expect(t.abortAgent).toHaveBeenCalledWith("bg");
  });
});
