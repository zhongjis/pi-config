import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExecutionRecord, execute, startExecution } from "../src/execution.js";
import { TURN_CEILING, TURN_CEILING_GRACE, TURN_CEILING_REMINDER, TURN_CHECK_IN } from "../src/turn-ceiling.js";
import { asAgentSession, deferred, fakeSession, flush, mockOpenSession, opened, type Script } from "./helpers/session-seam.js";

vi.mock("../src/turn-ceiling.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/turn-ceiling.js")>();
  return { ...actual, TURN_CEILING: 3, TURN_CHECK_IN: 2 };
});
// The real watch closes over its module constants/readers; mirror export stubs via supported overrides.
beforeEach(() => {
  vi.stubEnv("SUBAGENT_TURN_CEILING", String(TURN_CEILING));
  vi.stubEnv("SUBAGENT_TURN_CHECK_IN", String(TURN_CHECK_IN));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function record(): ExecutionRecord {
  return { status: "queued", startedAt: 0, toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
}

describe("openSession test adapter against Execution", () => {
  it.each<[string, Script, object]>([
    ["final text", () => "done", { text: "done", failure: undefined }],
    ["provider failure", () => ({ text: "partial", failure: "provider failed" }), { text: "partial", failure: "provider failed" }],
    ["rejected prompt", (_prompt, session) => { session.textDelta("partial"); throw new Error("prompt failed"); }, { text: "partial", failure: "prompt failed" }],
    ["SDK abort", (_prompt, session) => { session.textDelta("partial"); return { aborted: true }; }, { text: "partial", interruptionCause: "unknown" }],
  ])("supports %s", async (_name, script, expected) => {
    expect(await execute(asAgentSession(fakeSession(script)), "task")).toMatchObject(expected);
  });

  it("forwards usage, tools, compaction and deltas without leaking thinking/arguments", async () => {
    const hooks = { onTextDelta: vi.fn(), onProgress: vi.fn(), onAssistantUsage: vi.fn(), onToolActivity: vi.fn(), onCompaction: vi.fn() };
    const session = fakeSession((_prompt, child) => {
      child.usage({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 });
      child.textDelta("hello"); child.textDelta(" world");
      child.thinkingDelta(""); child.argumentDelta("");
      child.thinkingDelta("private thought"); child.argumentDelta("private args");
      child.toolStart("read"); child.toolEnd("read");
      child.compaction({ reason: "threshold", tokensBefore: 123 });
      child.compaction({ reason: "overflow", tokensBefore: 456 }, true);
      return {};
    });
    expect(await execute(asAgentSession(session), "task", hooks)).toMatchObject({ text: "hello world" });
    expect(hooks.onTextDelta.mock.calls).toEqual([["hello", "hello"], [" world", "hello world"]]);
    expect(hooks.onProgress).toHaveBeenCalledTimes(2);
    expect(hooks.onAssistantUsage).toHaveBeenCalledExactlyOnceWith({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 });
    expect(hooks.onToolActivity.mock.calls).toEqual([[{ type: "start", toolName: "read" }], [{ type: "end", toolName: "read" }]]);
    expect(hooks.onCompaction).toHaveBeenCalledExactlyOnceWith({ reason: "threshold", tokensBefore: 123 });
    expect(session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "hello world" }] });
    // Settlement unsubscribes all forwarding hooks.
    session.textDelta("late");
    expect(hooks.onTextDelta).toHaveBeenCalledTimes(2);
  });

  it("resets streaming text between assistant messages and executions", async () => {
    const session = fakeSession((_prompt, child) => {
      child.textDelta("first"); child.reply({}); child.textDelta("second"); return {};
    });
    const onTextDelta = vi.fn();
    expect(await execute(asAgentSession(session), "task", { onTextDelta })).toMatchObject({ text: "second" });
    expect(onTextDelta.mock.calls).toEqual([["first", "first"], ["second", "second"]]);
    session.prompt.mockRejectedValueOnce(new Error("resume failed"));
    expect(await execute(asAgentSession(session), "resume")).toMatchObject({ text: "", failure: "resume failed" });
    const rejected = fakeSession((prompt, child) => {
      child.textDelta(prompt);
      if (prompt === "old") throw new Error("failed");
      return {};
    });
    await execute(asAgentSession(rejected), "old");
    expect(await execute(asAgentSession(rejected), "new")).toMatchObject({ text: "new" });
    expect(rejected.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "new" }] });
  });

  it.each([false, true])("holds settlement through idle after prompt rejection=%s", async (reject) => {
    const session = fakeSession(() => { if (reject) throw new Error("failed"); return "done"; });
    const release = session.holdIdle();
    const settled = vi.fn();
    const run = execute(asAgentSession(session), "task").then(settled);
    await flush();
    expect(session.waitForIdle).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    release(); await run;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("forwards AbortSignal while keeping prompt and idle ownership", async () => {
    const controller = new AbortController();
    const session = fakeSession(async (_prompt, child) => { await child.aborted; return { aborted: true }; });
    const release = session.holdIdle();
    const settled = vi.fn();
    const run = execute(asAgentSession(session), "task", { signal: controller.signal }).then(settled);
    controller.abort(); await flush();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    release(); await run;
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ interruptionCause: "unknown" }));
  });

  it("holds or rejects the openSession source and forwards its prefix", async () => {
    const mock = mockOpenSession({ marker: "real export" });
    expect(mock.marker).toBe("real export");
    const opening = deferred<ReturnType<typeof opened>>();
    const source = vi.fn(() => opening.promise);
    const session = fakeSession();
    const state = record();
    const run = startExecution(state).run(source, "task");
    await flush();
    expect(state.status).toBe("running");
    expect(session.prompt).not.toHaveBeenCalled();
    opening.resolve(opened(session, "prefix: ")); await run;
    expect(session.prompt).toHaveBeenCalledExactlyOnceWith("prefix: task");
    expect(state).toMatchObject({ status: "completed", result: "prefix: task" });
    source.mockRejectedValueOnce(new Error("open failed"));
    await startExecution(state).run(source, "task");
    expect(state).toMatchObject({ status: "error", error: "open failed" });
  });

  it("checks in once, steers, then aborts unfinished turns at the ceiling", async () => {
    const onCheckIn = vi.fn(); const onTurnEnd = vi.fn();
    const session = fakeSession((_prompt, child) => {
      for (let turn = 0; turn < TURN_CEILING + TURN_CEILING_GRACE; turn++) child.turn(true);
      return { aborted: true };
    });
    expect(await execute(asAgentSession(session), "task", { onCheckIn, onTurnEnd })).toMatchObject({ forceSteered: true, interruptionCause: "turn-limit" });
    expect(onCheckIn).toHaveBeenCalledExactlyOnceWith(TURN_CHECK_IN);
    expect(onTurnEnd).toHaveBeenLastCalledWith(TURN_CEILING + TURN_CEILING_GRACE);
    expect(session.steer).toHaveBeenCalledExactlyOnceWith(TURN_CEILING_REMINDER);
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not check in for finished or terminating-tool turns (terminate=%s)", async (terminate) => {
    const onCheckIn = vi.fn();
    const session = fakeSession((_prompt, child) => {
      for (let turn = 0; turn < TURN_CEILING + TURN_CEILING_GRACE; turn++) {
        if (terminate) child.toolEnd("StructuredOutput", true);
        child.turn(terminate);
      }
      return "done";
    });
    expect(await execute(asAgentSession(session), "task", { onCheckIn })).toMatchObject({ forceSteered: false });
    expect(onCheckIn).not.toHaveBeenCalled(); expect(session.abort).not.toHaveBeenCalled();
  });

  it("captures structured output and repairs a missing first payload", async () => {
    const session = fakeSession((prompt, child) => {
      if (prompt !== "task") child.structuredOutput({ answer: 42 });
      return "prose";
    }, { structured: true });
    expect(await execute(asAgentSession(session), "task")).toMatchObject({ structuredJson: '{"answer":42}', structuredRetried: true, failure: undefined });
    expect(session.prompt).toHaveBeenCalledTimes(2);
    const direct = fakeSession((_prompt, child) => { child.structuredOutput({ answer: 7 }); return "done"; }, { structured: true });
    expect(await execute(asAgentSession(direct), "task")).toMatchObject({ structuredJson: '{"answer":7}', structuredRetried: false, failure: undefined });
    expect(() => fakeSession().structuredOutput({})).toThrow("structured: true");
  });
});
