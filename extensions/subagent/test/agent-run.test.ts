import { describe, expect, it } from "vitest";
import { SUBAGENTS_COMPLETED, SUBAGENTS_CREATED, SUBAGENTS_FAILED, SUBAGENTS_STARTED, SUBAGENTS_STEERED } from "../../lib/subagent-channels.js";
import { AgentRun, type AgentRunEvent, project, toExternalEffects } from "../src/agent-run.js";

/** Run with a controllable clock for deterministic timestamp assertions. */
function makeRun(start = 1000) {
  let clock = start;
  const run = new AgentRun("a1", { now: () => clock });
  const setClock = (t: number) => {
    clock = t;
  };
  return { run, setClock };
}

function created(overrides: Partial<Extract<AgentRunEvent, { kind: "created" }>> = {}): AgentRunEvent {
  return {
    kind: "created",
    type: "general-purpose",
    description: "do a thing",
    isBackground: true,
    startedAt: 1000,
    ...overrides,
  };
}

const BG = { isBackground: true } as const;
const FG = { isBackground: false } as const;

describe("AgentRun reducer — status derivation", () => {
  it("created → queued, started → running", () => {
    const { run } = makeRun();
    expect(run.status).toBe("queued");
    run.publish(created());
    expect(run.status).toBe("queued");
    run.publish({ kind: "started", startedAt: 1000 });
    expect(run.status).toBe("running");
    expect(run.isTerminal()).toBe(false);
  });

  it("completed carries explicit status (completed vs steered)", () => {
    const a = makeRun().run;
    a.publish(created());
    a.publish({ kind: "completed", result: "ok", status: "completed" });
    expect(a.status).toBe("completed");
    expect(a.result).toBe("ok");
    expect(a.isTerminal()).toBe(true);

    const b = makeRun().run;
    b.publish(created());
    b.publish({ kind: "completed", result: "wrapped", status: "steered" });
    expect(b.status).toBe("steered");
  });

  it("aborted carries explicit status (aborted vs stopped); failed → error", () => {
    const a = makeRun().run;
    a.publish(created());
    a.publish({ kind: "aborted", status: "aborted", reason: "max_turns" });
    expect(a.status).toBe("aborted");

    const b = makeRun().run;
    b.publish(created());
    b.publish({ kind: "aborted", status: "stopped", reason: "user" });
    expect(b.status).toBe("stopped");

    const c = makeRun().run;
    c.publish(created());
    c.publish({ kind: "failed", error: "boom" });
    expect(c.status).toBe("error");
    expect(c.error).toBe("boom");
  });

  it("aborted event with error sets run.error", () => {
    const { run } = makeRun();
    run.publish(created());
    run.publish({ kind: "aborted", status: "stopped", reason: "user", error: "Agent was stopped while running." });
    expect(run.status).toBe("stopped");
    expect(run.error).toBe("Agent was stopped while running.");
  });

  it("aborted event WITHOUT error field does not set run.error (?? preserves undefined)", () => {
    const { run } = makeRun();
    run.publish(created());
    // event.error = undefined, this.error = undefined → undefined ?? undefined = undefined
    run.publish({ kind: "aborted", status: "stopped", reason: "user" }); // no error field
    expect(run.error).toBeUndefined();
  });

  it("max_turns aborted event carries no error by default", () => {
    const { run } = makeRun();
    run.publish(created());
    run.publish({ kind: "aborted", status: "aborted", reason: "max_turns" });
    expect(run.status).toBe("aborted");
    expect(run.error).toBeUndefined();
  });
});

describe("AgentRun reducer — terminal idempotency & resume", () => {
  it("first terminal wins — a second terminal event is ignored (no double-settle)", () => {
    const { run, setClock } = makeRun(1000);
    run.publish(created());
    setClock(2000);
    // External abort path sets stopped first...
    run.publish({ kind: "aborted", status: "stopped", reason: "user" });
    expect(run.status).toBe("stopped");
    expect(run.completedAt).toBe(2000);
    // ...then the promise settles and tries to terminalize again — must be ignored.
    setClock(3000);
    run.publish({ kind: "completed", result: "late", status: "completed" });
    expect(run.status).toBe("stopped");
    expect(run.result).toBeUndefined();
    expect(run.completedAt).toBe(2000);
    expect(run.events().filter((e) => e.kind === "completed")).toHaveLength(0);
  });

  it("resumed reopens a terminal run and allows a fresh terminal", () => {
    const { run } = makeRun();
    run.publish(created());
    run.publish({ kind: "completed", result: "first", status: "completed" });
    expect(run.isTerminal()).toBe(true);

    run.publish({ kind: "resumed" });
    expect(run.status).toBe("running");
    expect(run.isTerminal()).toBe(false);
    expect(run.completedAt).toBeUndefined();
    expect(run.result).toBeUndefined();

    run.publish({ kind: "completed", result: "second", status: "completed" });
    expect(run.status).toBe("completed");
    expect(run.result).toBe("second");
  });

  it("result_amended on a non-terminal run is a no-op (pre-terminal guard)", () => {
    const { run } = makeRun();
    run.publish(created());
    run.publish({ kind: "started", startedAt: 1000 });
    expect(run.status).toBe("running"); // non-terminal

    run.publish({ kind: "result_amended", result: "should not stick" });
    expect(run.result).toBeUndefined(); // guard rejected it
  });
});

describe("AgentRun reducer — activity", () => {
  it("created seeds meta and lastProgressAt from startedAt; durable identity fields", () => {
    const { run } = makeRun();
    run.publish(
      created({
        startedAt: 1000,
        maxTurns: 30,
        parentSessionId: "parent-1",
        sessionDir: "/dir",
        toolCallId: "tc-9",
        modelLabel: "anthropic/claude-sonnet-4-6",
      }),
    );
    expect(run.type).toBe("general-purpose");
    expect(run.isBackground).toBe(true);
    expect(run.startedAt).toBe(1000);
    expect(run.activity.maxTurns).toBe(30);
    expect(run.activity.lastProgressAt).toBe(1000);
    expect(run.parentSessionId).toBe("parent-1");
    expect(run.sessionDir).toBe("/dir");
    expect(run.toolCallId).toBe("tc-9");
    expect(run.modelLabel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("output_file_ready sets outputFile/sessionFile after spawn", () => {
    const { run } = makeRun();
    run.publish(created());
    run.publish({ kind: "output_file_ready", outputFile: "/out.txt", sessionFile: "/s.jsonl" });
    expect(run.outputFile).toBe("/out.txt");
    expect(run.sessionFile).toBe("/s.jsonl");
  });

  it("tool start adds an active tool and advances progress; tool end increments toolUses without advancing progress", () => {
    const { run, setClock } = makeRun(1000);
    run.publish(created());
    setClock(2000);
    run.publish({ kind: "tool", phase: "start", toolName: "read" });
    expect(run.activity.activeTools.size).toBe(1);
    expect(run.activity.lastProgressAt).toBe(2000);

    setClock(3000);
    run.publish({ kind: "tool", phase: "end", toolName: "read" });
    expect(run.activity.activeTools.size).toBe(0);
    expect(run.activity.toolUses).toBe(1);
    // tool end mirrors refreshActivity (no markProgress)
    expect(run.activity.lastProgressAt).toBe(2000);
  });

  it("two concurrent tool starts at the same clock tick both count (monotonic keys)", () => {
    const { run } = makeRun(1000);
    run.publish(created());
    run.publish({ kind: "tool", phase: "start", toolName: "read" });
    run.publish({ kind: "tool", phase: "start", toolName: "read" });
    expect(run.activity.activeTools.size).toBe(2);
  });

  it("text_delta sets responseText + streaming flags; message_start resets streamingDeltasSeen", () => {
    const { run, setClock } = makeRun(1000);
    run.publish(created());
    setClock(2500);
    run.publish({ kind: "text_delta", delta: "he", fullText: "hello" });
    expect(run.activity.responseText).toBe("hello");
    expect(run.activity.streamingDeltasSeen).toBe(true);
    expect(run.activity.nonStreamingSince).toBeUndefined();
    expect(run.activity.lastProgressAt).toBe(2500);

    run.publish({ kind: "message_start" });
    expect(run.activity.streamingDeltasSeen).toBe(false);
  });

  it("progress mirrors markStreamingProgress", () => {
    const { run, setClock } = makeRun(1000);
    run.publish(created());
    run.publish({ kind: "message_start" });
    expect(run.activity.streamingDeltasSeen).toBe(false);
    setClock(4000);
    run.publish({ kind: "progress" });
    expect(run.activity.streamingDeltasSeen).toBe(true);
    expect(run.activity.lastProgressAt).toBe(4000);
  });

  it("mark_non_streaming stamps nonStreamingSince from the clock", () => {
    const { run, setClock } = makeRun(1000);
    run.publish(created());
    setClock(6000);
    run.publish({ kind: "mark_non_streaming" });
    expect(run.activity.nonStreamingSince).toBe(6000);
  });

  it("turn_end updates turnCount and advances progress; tokens updates token string", () => {
    const { run, setClock } = makeRun(1000);
    run.publish(created());
    setClock(5000);
    run.publish({ kind: "turn_end", turnCount: 4 });
    expect(run.activity.turnCount).toBe(4);
    expect(run.activity.lastProgressAt).toBe(5000);
    run.publish({ kind: "tokens", tokens: "33.8k" });
    expect(run.activity.tokens).toBe("33.8k");
  });
});

describe("AgentRun — supervision projections", () => {
  it("activitySnapshot matches the ActivitySnapshot shape supervision consumes", () => {
    const { run, setClock } = makeRun(1000);
    run.publish(created());
    setClock(2000);
    run.publish({ kind: "tool", phase: "start", toolName: "bash" });
    const snap = run.activitySnapshot();
    expect(snap).toEqual({
      lastProgressAt: 2000,
      activeTools: { size: 1 },
      streamingDeltasSeen: false,
      nonStreamingSince: undefined,
    });
  });

  it("recordSnapshot matches the RecordSnapshot shape supervision consumes", () => {
    const { run } = makeRun(1000);
    run.publish(created({ isBackground: true, startedAt: 1000 }));
    run.publish({ kind: "started", startedAt: 1000 });
    run.publish({ kind: "waiter", delta: 1 });
    const snap = run.recordSnapshot();
    expect(snap).toEqual({
      status: "running",
      isBackground: true,
      lastSupervisionSteerAt: undefined,
      lastSupervisionAbortAt: undefined,
      waitingConsumers: 1,
      startedAt: 1000,
    });
  });

  it("supervision-origin steer records lastSupervisionSteerAt; user-origin does not", () => {
    const { run } = makeRun(1000);
    run.publish(created());
    run.publish({ kind: "steered", message: "wrap up", origin: "supervision", at: 7777 });
    expect(run.lastSupervisionSteerAt).toBe(7777);

    run.publish({ kind: "steered", message: "hi", origin: "user", at: 8888 });
    expect(run.lastSupervisionSteerAt).toBe(7777);
  });

  it("only ceiling/supervision abort records lastSupervisionAbortAt", () => {
    const ceiling = makeRun(1000);
    ceiling.run.publish(created());
    ceiling.setClock(9000);
    ceiling.run.publish({ kind: "aborted", status: "aborted", reason: "ceiling" });
    expect(ceiling.run.lastSupervisionAbortAt).toBe(9000);

    for (const reason of ["max_turns", "user"] as const) {
      const r = makeRun(1000);
      r.run.publish(created());
      r.run.publish({ kind: "aborted", status: reason === "user" ? "stopped" : "aborted", reason });
      expect(r.run.lastSupervisionAbortAt).toBeUndefined();
    }
  });

  it("waiter delta clamps at zero", () => {
    const { run } = makeRun();
    run.publish(created());
    run.publish({ kind: "waiter", delta: 1 });
    run.publish({ kind: "waiter", delta: -1 });
    run.publish({ kind: "waiter", delta: -1 });
    expect(run.waitingConsumers).toBe(0);
  });
});

describe("AgentRun — waitForTerminal (push completion)", () => {
  it("resolves when a terminal event is published", async () => {
    const { run } = makeRun();
    run.publish(created());
    run.publish({ kind: "started", startedAt: 1000 });
    const pending = run.waitForTerminal();
    run.publish({ kind: "completed", result: "done", status: "completed" });
    await expect(pending).resolves.toEqual({ status: "completed", result: "done", error: undefined });
  });

  it("resolves immediately if already terminal", async () => {
    const { run } = makeRun();
    run.publish(created());
    run.publish({ kind: "failed", error: "x" });
    await expect(run.waitForTerminal()).resolves.toEqual({ status: "error", result: undefined, error: "x" });
  });
});

describe("AgentRun — subscriptions", () => {
  it("delivers events in order and supports unsubscribe", () => {
    const { run } = makeRun();
    const seen: string[] = [];
    const unsub = run.subscribe((e) => seen.push(e.kind));
    run.publish(created());
    run.publish({ kind: "started", startedAt: 1000 });
    unsub();
    run.publish({ kind: "completed", result: "r", status: "completed" });
    expect(seen).toEqual(["created", "started"]);
    // the run still records the full ordered log even after unsubscribe
    expect(run.events().map((e) => e.kind)).toEqual(["created", "started", "completed"]);
  });
});

describe("toExternalEffects — frozen contract mapping", () => {
  it("background runs reproduce the verified external effects", () => {
    expect(toExternalEffects(created({ isBackground: true }), BG)).toEqual([
      { type: "event", name: SUBAGENTS_CREATED },
    ]);
    expect(toExternalEffects({ kind: "started", startedAt: 1000 }, BG)).toEqual([{ type: "event", name: SUBAGENTS_STARTED }]);
    expect(toExternalEffects({ kind: "completed", result: "r", status: "completed" }, BG)).toEqual([
      { type: "event", name: SUBAGENTS_COMPLETED },
      { type: "record" },
    ]);
    expect(toExternalEffects({ kind: "completed", result: "r", status: "steered" }, BG)).toEqual([
      { type: "event", name: SUBAGENTS_COMPLETED },
      { type: "record" },
    ]);
    expect(toExternalEffects({ kind: "aborted", status: "aborted", reason: "max_turns" }, BG)).toEqual([
      { type: "event", name: SUBAGENTS_FAILED },
      { type: "record" },
    ]);
    expect(toExternalEffects({ kind: "aborted", status: "stopped", reason: "user" }, BG)).toEqual([
      { type: "event", name: SUBAGENTS_FAILED },
      { type: "record" },
    ]);
    expect(toExternalEffects({ kind: "failed", error: "e" }, BG)).toEqual([
      { type: "event", name: SUBAGENTS_FAILED },
      { type: "record" },
    ]);
  });

  it("foreground runs only emit subagents:started (created/terminal/record are bg-only)", () => {
    expect(toExternalEffects(created({ isBackground: false }), FG)).toEqual([]);
    expect(toExternalEffects({ kind: "started", startedAt: 1000 }, FG)).toEqual([{ type: "event", name: SUBAGENTS_STARTED }]);
    expect(toExternalEffects({ kind: "completed", result: "r", status: "completed" }, FG)).toEqual([]);
    expect(toExternalEffects({ kind: "aborted", status: "aborted", reason: "max_turns" }, FG)).toEqual([]);
    expect(toExternalEffects({ kind: "failed", error: "e" }, FG)).toEqual([]);
  });

  it("subagents:steered fires only for user-origin steers", () => {
    expect(toExternalEffects({ kind: "steered", message: "m", origin: "user", at: 1 }, BG)).toEqual([
      { type: "event", name: SUBAGENTS_STEERED },
    ]);
    expect(toExternalEffects({ kind: "steered", message: "m", origin: "supervision", at: 1 }, BG)).toEqual([]);
  });

  it("emits no external effects for internal-only events", () => {
    const internalOnly: AgentRunEvent[] = [
      { kind: "resumed" },
      { kind: "session_created", session: {} },
      { kind: "output_file_ready", outputFile: "/o" },
      { kind: "message_start" },
      { kind: "tool", phase: "start", toolName: "read" },
      { kind: "text_delta", delta: "a", fullText: "a" },
      { kind: "progress" },
      { kind: "mark_non_streaming" },
      { kind: "tokens", tokens: "1k" },
      { kind: "turn_end", turnCount: 2 },
      { kind: "waiter", delta: 1 },
    ];
    for (const e of internalOnly) expect(toExternalEffects(e, BG)).toEqual([]);
  });
});

describe("AgentRun — realistic sequence", () => {
  it("reduces a full background run to the expected final state", async () => {
    const { run, setClock } = makeRun(1000);
    const terminal = run.waitForTerminal();
    run.publish(created({ startedAt: 1000, maxTurns: 30 }));
    run.publish({ kind: "started", startedAt: 1000 });
    run.publish({ kind: "session_created", session: { id: "s" } });
    run.publish({ kind: "message_start" });
    setClock(1100);
    run.publish({ kind: "tool", phase: "start", toolName: "read" });
    run.publish({ kind: "tool", phase: "end", toolName: "read" });
    setClock(1200);
    run.publish({ kind: "text_delta", delta: "all ", fullText: "all done" });
    run.publish({ kind: "turn_end", turnCount: 2 });
    run.publish({ kind: "tokens", tokens: "12.0k" });
    setClock(1300);
    run.publish({ kind: "completed", result: "all done", status: "completed" });

    expect(run.status).toBe("completed");
    expect(run.activity.toolUses).toBe(1);
    expect(run.activity.turnCount).toBe(2);
    expect(run.activity.responseText).toBe("all done");
    expect(run.activity.tokens).toBe("12.0k");
    expect(run.completedAt).toBe(1300);
    await expect(terminal).resolves.toEqual({ status: "completed", result: "all done", error: undefined });
  });
});

describe("project() — terminal projector", () => {
  it("writes status/result/error/completedAt/startedAt from run to record", () => {
    const run = new AgentRun("p1", { now: () => 9000 });
    run.publish({ kind: "created", type: "general-purpose", description: "d", isBackground: false, startedAt: 100 });
    run.publish({ kind: "started", startedAt: 500 }); // actual-start overrides creation time
    run.publish({ kind: "completed", result: "done", status: "completed" });

    const record = {
      id: "p1", type: "general-purpose", description: "d",
      status: "running" as const, toolUses: 0,
      startedAt: 999,  // will be overwritten by project() with run.startedAt
    } as any;

    project(run, record);

    expect(record.status).toBe("completed");
    expect(record.result).toBe("done");
    expect(record.error).toBeUndefined();
    expect(record.completedAt).toBe(run.completedAt);
    // project() copies run.startedAt (set by started event, not creation time)
    expect(record.startedAt).toBe(500);
    expect(record.startedAt).toBe(run.startedAt);
  });

  it("started event overrides queued creation startedAt (queued-agent actual-start scenario)", () => {
    const run = new AgentRun("q1", { now: () => 9000 });
    run.publish({ kind: "created", type: "general-purpose", description: "d", isBackground: true, startedAt: 100 });
    expect(run.startedAt).toBe(100); // queue/creation time

    run.publish({ kind: "started", startedAt: 500 }); // actual-start time (later, from drainQueue)
    expect(run.startedAt).toBe(500);

    run.publish({ kind: "completed", result: "done", status: "completed" });

    const record = { id: "q1", type: "general-purpose", description: "d", status: "running" as const, toolUses: 0, startedAt: 100 } as any;
    project(run, record);
    expect(record.startedAt).toBe(500); // project() copied actual-start, not queue time
    expect(record.startedAt).toBe(run.startedAt);
  });
});

describe("project() subscriber — synchronous projection invariant", () => {
  it("immediately after publish() returns, record fields are already projected (no await)", () => {
    const run = new AgentRun("sync1", { now: () => 9000 });
    const record: any = { id: "sync1", status: "queued", startedAt: 0 };
    // Wire subscriber exactly as agent-manager.ts spawn does
    run.subscribe((_event, r) => project(r, record));

    run.publish({ kind: "created", type: "general-purpose", description: "d", isBackground: false, startedAt: 1000 });
    run.publish({ kind: "started", startedAt: 1500 });
    // synchronous — no await
    expect(record.status).toBe("running");
    expect(record.startedAt).toBe(1500);

    run.publish({ kind: "completed", result: "done", status: "completed" });
    // synchronous — no await
    expect(record.status).toBe("completed");
    expect(record.result).toBe("done");
    expect(record.completedAt).toBe(9000);
  });

  it("stop publish projects status=stopped synchronously (the .then guard invariant)", () => {
    const run = new AgentRun("sync2", { now: () => 9000 });
    const record: any = { id: "sync2", status: "running", startedAt: 0 };
    run.subscribe((_event, r) => project(r, record));

    run.publish({ kind: "created", type: "general-purpose", description: "d", isBackground: false, startedAt: 1000 });
    run.publish({ kind: "started", startedAt: 1500 });
    run.publish({ kind: "aborted", status: "stopped", reason: "user", error: "Agent was stopped while running." });
    // synchronous — no await
    expect(record.status).toBe("stopped");
    expect(record.error).toBe("Agent was stopped while running.");
    expect(record.completedAt).toBe(9000);
  });
});

describe("AgentRun — consumed / notified events", () => {
  it("(a) completed then consumed → run.resultConsumed true; project() sets record.resultConsumed", () => {
    const run = new AgentRun("c1", { now: () => 5000 });
    const record: any = { id: "c1", status: "queued", startedAt: 0 };
    run.subscribe((_e, r) => project(r, record));

    run.publish({ kind: "created", type: "general-purpose", description: "d", isBackground: false, startedAt: 1000 });
    run.publish({ kind: "started", startedAt: 1000 });
    run.publish({ kind: "completed", result: "done", status: "completed" });
    expect(run.resultConsumed).toBe(false);

    run.publish({ kind: "consumed" });
    expect(run.resultConsumed).toBe(true);
    expect(record.resultConsumed).toBe(true);
  });

  it("(b) notified → run.notified true; project() sets record.notified", () => {
    const run = new AgentRun("n1", { now: () => 5000 });
    const record: any = { id: "n1", status: "queued", startedAt: 0 };
    run.subscribe((_e, r) => project(r, record));

    run.publish({ kind: "created", type: "general-purpose", description: "d", isBackground: false, startedAt: 1000 });
    run.publish({ kind: "completed", result: "done", status: "completed" });

    run.publish({ kind: "notified" });
    expect(run.notified).toBe(true);
    expect(record.notified).toBe(true);
  });

  it("(c) consumed/notified published AFTER terminal are NOT dropped by first-terminal-wins guard", () => {
    const run = new AgentRun("g1", { now: () => 5000 });
    run.publish({ kind: "created", type: "general-purpose", description: "d", isBackground: false, startedAt: 1000 });
    run.publish({ kind: "completed", result: "done", status: "completed" });
    expect(run.isTerminal()).toBe(true);

    // These must NOT be swallowed by the terminal guard
    run.publish({ kind: "consumed" });
    run.publish({ kind: "notified" });
    expect(run.resultConsumed).toBe(true);
    expect(run.notified).toBe(true);
    // Both events appear in the log
    expect(run.events().map((e) => e.kind)).toContain("consumed");
    expect(run.events().map((e) => e.kind)).toContain("notified");
  });

  it("(d) duplicate terminal events still ignored (existing invariant holds)", () => {
    const run = new AgentRun("d1", { now: () => 5000 });
    run.publish({ kind: "created", type: "general-purpose", description: "d", isBackground: false, startedAt: 1000 });
    run.publish({ kind: "completed", result: "first", status: "completed" });
    run.publish({ kind: "completed", result: "second", status: "completed" });
    expect(run.result).toBe("first");
    expect(run.events().filter((e) => e.kind === "completed")).toHaveLength(1);
  });
});
