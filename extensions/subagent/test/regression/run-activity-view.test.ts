// Phase 2b — locks the live AgentActivity view backed by AgentRun. This is what the
// agentActivity map now stores, so the widget / supervision / get_subagent_result /
// /agents all read from the single source. Getters must reflect live run state, and
// the nonStreamingSince setter must route supervision's write back into the run.
import { describe, expect, it } from "vitest";
import { AgentRun } from "../../src/agent-run.js";
import { runActivityView } from "../../src/tools/agent.js";

function fakeSession(total: number) {
  return { getSessionStats: () => ({ tokens: { total } }) };
}

function startedRun() {
  let clock = 1000;
  const run = new AgentRun("a1", { now: () => clock });
  run.publish({ kind: "created", type: "general-purpose", description: "d", isBackground: true, startedAt: 1000 });
  run.publish({ kind: "started" });
  return { run, setClock: (t: number) => (clock = t) };
}

describe("runActivityView — live projection of AgentRun", () => {
  it("getters reflect run.activity live as events are published", () => {
    const { run, setClock } = startedRun();
    const view = runActivityView(run);

    expect(view.toolUses).toBe(0);
    expect(view.turnCount).toBe(1);
    expect(view.activeTools.size).toBe(0);
    expect(view.responseText).toBe("");

    setClock(2000);
    run.publish({ kind: "tool", phase: "start", toolName: "read" });
    expect(view.activeTools.size).toBe(1);
    expect(view.lastProgressAt).toBe(2000);

    run.publish({ kind: "tool", phase: "end", toolName: "read" });
    expect(view.toolUses).toBe(1);
    expect(view.activeTools.size).toBe(0);

    run.publish({ kind: "text_delta", delta: "hi", fullText: "hi there" });
    expect(view.responseText).toBe("hi there");
    expect(view.streamingDeltasSeen).toBe(true);

    run.publish({ kind: "turn_end", turnCount: 3 });
    expect(view.turnCount).toBe(3);
  });

  it("tokens are derived from run.session (empty until a session is attached)", () => {
    const { run } = startedRun();
    const view = runActivityView(run);
    expect(view.tokens).toBe("");
    expect(view.session).toBeUndefined();

    run.publish({ kind: "session_created", session: fakeSession(12000) });
    expect(view.session).toBeDefined();
    expect(view.tokens).not.toBe("");
  });

  it("nonStreamingSince getter reads the run; setter writes back into the run", () => {
    const { run } = startedRun();
    const view = runActivityView(run);
    expect(view.nonStreamingSince).toBeUndefined();

    // Supervision marks non-streaming by assigning to the activity (was a direct mutation).
    view.nonStreamingSince = 5555;
    expect(run.activity.nonStreamingSince).toBe(5555);
    expect(view.nonStreamingSince).toBe(5555);

    // A streaming event clears it on the run, and the view reflects that.
    run.publish({ kind: "text_delta", delta: "x", fullText: "x" });
    expect(view.nonStreamingSince).toBeUndefined();
  });

  it("maxTurns flows from the created event", () => {
    let clock = 1000;
    const run = new AgentRun("a2", { now: () => clock });
    run.publish({ kind: "created", type: "t", description: "d", isBackground: true, startedAt: 1000, maxTurns: 30 });
    const view = runActivityView(run);
    expect(view.maxTurns).toBe(30);
  });
});
