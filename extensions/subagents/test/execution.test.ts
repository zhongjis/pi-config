import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExecutionRecord, execute, startExecution } from "../src/execution.js";
import {
  createStructuredCapture,
  createStructuredOutputTool,
  rememberStructuredCapture,
  structuredFailure,
} from "../src/structured-output.js";
import { TURN_CEILING_REMINDER } from "../src/turn-ceiling.js";
import { asAgentSession, fakeSession, opened } from "./helpers/session-seam.js";

function createSession(finalText: string) {
  const session = fakeSession();
  const listeners: Array<(event: object) => void> = [];
  session.subscribe.mockImplementation((listener) => {
    listeners.push(listener);
    return () => {
      listeners.splice(listeners.indexOf(listener), 1);
    };
  });
  session.prompt.mockImplementation(async () => {
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: finalText }],
    });
  });
  return { session, listeners };
}
afterEach(() => {
  vi.unstubAllEnvs();
});
it.each(["fresh", "resume"] as const)(
  "%s heartbeats only non-empty thinking/toolcall deltas without exposing their payloads",
  async (kind) => {
    const { session, listeners } = createSession("unused");
    if (kind === "resume") await execute(asAgentSession(session), "prior");
    const onProgress = vi.fn();
    const onTextDelta = vi.fn();
    const emit = (
      type: "thinking_delta" | "toolcall_delta" | "text_delta" | "thinking_start" | "toolcall_start",
      delta: string,
    ) => {
      for (const listener of listeners)
        listener({
          type: "message_update",
          assistantMessageEvent: { type, delta },
        });
    };
    session.prompt.mockImplementation(async () => {
      emit("thinking_start", "");
      emit("toolcall_start", "");
      emit("thinking_delta", "");
      emit("toolcall_delta", "");
      expect(onProgress).not.toHaveBeenCalled();
      emit("thinking_delta", "private reasoning");
      emit("toolcall_delta", " ");
      emit("text_delta", "answer");
    });
    const options = { onProgress, onTextDelta };
    const text = (await execute(asAgentSession(session), "go", options)).text;
    expect(onProgress.mock.calls).toEqual([[], []]);
    expect(onTextDelta.mock.calls).toEqual([["answer", "answer"]]);
    expect(text).toBe("answer");
    emit("thinking_delta", "settled");
    emit("toolcall_delta", "settled");
    expect(onProgress).toHaveBeenCalledTimes(2);
  },
);
it.each([
  ["fresh", false],
  ["fresh", true],
  ["resume", false],
  ["resume", true],
] as const)(
  "%s drains rejected prompts and retains only execution-local partial text (abort=%s)",
  async (kind, abort) => {
    const controller = new AbortController();
    const { session, listeners } = createSession("unused");
    if (kind === "resume") await execute(asAgentSession(session), "prior");
    session.prompt.mockClear();
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "PRIOR" }],
    });
    let releaseIdle: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    if (!releaseIdle) throw new Error("Missing idle resolver");
    session.waitForIdle.mockImplementation(() => idle);
    session.prompt.mockImplementation(async () => {
      for (const listener of listeners)
        listener({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "PARTIAL" },
        });
      if (abort) controller.abort();
      throw new Error("prompt failed");
    });
    const onTextDelta = vi.fn();
    const pending = execute(asAgentSession(session), "go", {
      signal: controller.signal,
      onTextDelta,
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    try {
      expect(settled).toBe(false);
      expect(session.waitForIdle).toHaveBeenCalled();
      for (const listener of listeners)
        listener({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: " DRAIN" },
        });
    } finally {
      releaseIdle();
    }
    await expect(pending).resolves.toMatchObject({
      text: "PARTIAL DRAIN",
      failure: "prompt failed",
    });
    expect(onTextDelta.mock.calls).toEqual([
      ["PARTIAL", "PARTIAL"],
      [" DRAIN", "PARTIAL DRAIN"],
    ]);
    if (abort) expect(session.abort).toHaveBeenCalledOnce();
    session.prompt.mockRejectedValueOnce(new Error("empty failure"));
    await expect(execute(asAgentSession(session), "again")).resolves.toMatchObject({
      text: "",
      failure: "empty failure",
    });
  },
);
it("retains execution-local completed text across compaction and an empty aborted message", async () => {
  const { session, listeners } = createSession("unused");
  await execute(asAgentSession(session), "prior");
  session.prompt.mockClear();
  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "PRIOR" }],
  });
  session.prompt.mockImplementation(async () => {
    for (const listener of listeners)
      listener({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "PARTIAL" }],
        },
      });
    session.messages.length = 0;
    for (const listener of listeners)
      listener({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
    throw new Error("aborted");
  });
  await expect(execute(asAgentSession(session), "go")).resolves.toMatchObject({
    text: "PARTIAL",
    failure: "aborted",
  });
});
it("returns the final assistant text even when no text_delta events were streamed", async () => {
  const { session } = createSession("LOCKED");
  const result = await execute(asAgentSession(session), "Say LOCKED");
  expect(result.text).toBe("LOCKED");
});
it.each([false, true])(
  "A04 does not steer finished turns or terminating tool completions past the ceiling (%s)",
  async (terminatingTool) => {
    vi.stubEnv("SUBAGENT_TURN_CEILING", "1");
    const { session, listeners } = createSession("DONE");
    session.prompt.mockImplementation(async () => {
      for (let turn = 0; turn < 8; turn++) {
        if (terminatingTool)
          for (const listener of listeners)
            listener({
              type: "tool_execution_end",
              toolName: "read",
              result: { terminate: true },
            });
        for (const listener of listeners)
          listener({
            type: "turn_end",
            message: {
              role: "assistant",
              stopReason: terminatingTool ? "toolUse" : "stop",
              content: terminatingTool ? [{ type: "toolCall", name: "read" }] : [{ type: "text", text: "DONE" }],
            },
            toolResults: [],
          });
      }
    });
    const result = await execute(asAgentSession(session), "go");
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.forceSteered).toBe(false);
  },
);
it.each(["fresh", "resume"] as const)(
  "A04 %s steers unfinished tool turns at the ceiling and aborts after the grace turns",
  async (kind) => {
    vi.stubEnv("SUBAGENT_TURN_CEILING", "2");
    const { session, listeners } = createSession("DONE");
    if (kind === "resume") await execute(asAgentSession(session), "prior");
    const turnsAt: Record<string, number> = {};
    let turns = 0;
    session.steer.mockImplementation(async () => {
      turnsAt.steer = turns;
    });
    session.abort.mockImplementation(async () => {
      turnsAt.abort = turns;
    });
    session.prompt.mockImplementation(async () => {
      for (let turn = 0; turn < 20 && turnsAt.abort === undefined; turn++) {
        turns++;
        for (const listener of listeners)
          listener({
            type: "tool_execution_end",
            toolName: "read",
            result: {},
          });
        for (const listener of listeners)
          listener({
            type: "turn_end",
            message: {
              role: "assistant",
              stopReason: "toolUse",
              content: [{ type: "toolCall", name: "read" }],
            },
            toolResults: [],
          });
      }
    });
    const onTurnEnd = vi.fn();
    const result = await execute(asAgentSession(session), "go", { onTurnEnd });
    expect(session.steer.mock.calls).toEqual([[TURN_CEILING_REMINDER]]);
    expect(turnsAt).toEqual({ steer: 2, abort: 7 });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenLastCalledWith(7);
    expect(result).toMatchObject({
      interruptionCause: "turn-limit",
      forceSteered: true,
    });
  },
);
it.each(["fresh", "resume"] as const)("%s passes the orchestrator check-in to the turn watch", async (kind) => {
  vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "2");
  const { session, listeners } = createSession("DONE");
  if (kind === "resume") await execute(asAgentSession(session), "prior");
  session.prompt.mockImplementation(async () => {
    for (let turn = 0; turn < 4; turn++) {
      for (const listener of listeners)
        listener({
          type: "turn_end",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "toolCall", name: "read" }],
          },
          toolResults: [],
        });
    }
  });
  const onCheckIn = vi.fn();
  await execute(asAgentSession(session), "go", { onCheckIn });
  expect(onCheckIn).toHaveBeenCalledExactlyOnceWith(2);
  expect(session.steer).not.toHaveBeenCalled();
});
it("A04 resume counts turns per Execution and reports a forced wrap-up", async () => {
  vi.stubEnv("SUBAGENT_TURN_CEILING", "2");
  const { session, listeners } = createSession("DONE");
  const toolTurn = () => {
    for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "read", result: {} });
    for (const listener of listeners)
      listener({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", name: "read" }],
        },
        toolResults: [],
      });
  };
  session.prompt.mockImplementation(async () => {
    toolTurn();
  });
  const first = await execute(asAgentSession(session), "prior");
  expect(first.forceSteered).toBe(false);
  const resumed = await execute(asAgentSession(session), "go");
  expect(session.steer).not.toHaveBeenCalled();
  expect(resumed.forceSteered).toBe(false);
  session.prompt.mockImplementation(async () => {
    toolTurn();
    toolTurn();
    for (const listener of listeners)
      listener({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "DONE" }],
        },
        toolResults: [],
      });
  });
  const wrapped = await execute(asAgentSession(session), "go");
  expect(session.steer).toHaveBeenCalledTimes(1);
  expect(session.abort).not.toHaveBeenCalled();
  expect(wrapped).toMatchObject({
    forceSteered: true,
    interruptionCause: undefined,
  });
});
it("an execution on an existing transcript falls back to its new final assistant message text", async () => {
  const { session } = createSession("RESUMED");
  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "PRIOR" }],
  });
  const result = await execute(asAgentSession(session), "Continue");
  expect(result.text).toBe("RESUMED");
  expect(result.failure).toBeUndefined();
});
describe("Execution failed-final-turn detection (#144)", () => {
  /** Session whose prompt() appends the given messages to history. */
  function sessionEnding(...messages: object[]) {
    const { session } = createSession("");
    session.prompt.mockImplementation(async () => {
      session.messages.push(...messages);
    });
    return session;
  }
  const errorFinal = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "retries exhausted: 529 overloaded",
  };
  it("propagates SDK abort without a controller as unknown on fresh and resumed runs", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "checkpoint" }],
      stopReason: "aborted",
    });
    const result = await execute(asAgentSession(session), "go");
    expect(result).toMatchObject({
      interruptionCause: "unknown",
      text: "checkpoint",
    });
    const resumed = await execute(asAgentSession(session), "continue");
    expect(resumed).toMatchObject({
      interruptionCause: "unknown",
      text: "checkpoint",
    });
  });
  it("flags a run whose final turn is an empty provider error", async () => {
    const session = sessionEnding(errorFinal);
    const result = await execute(asAgentSession(session), "go");
    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });
  it("flags the failure even when an EARLIER turn produced text (no masking)", async () => {
    const session = sessionEnding(
      {
        role: "assistant",
        content: [{ type: "text", text: "partial progress" }],
      },
      { role: "toolResult", content: [] },
      errorFinal,
    );
    const result = await execute(asAgentSession(session), "go");
    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    // The earlier text stays available as context — status honesty, not data loss.
    expect(result.text).toBe("partial progress");
  });
  it("flags a provider error that left partial text in the SAME final message", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated answ" }],
      stopReason: "error",
      errorMessage: "stream ended before message_stop",
    });
    const result = await execute(asAgentSession(session), "go");
    expect(result.failure).toBe("stream ended before message_stop");
    expect(result.text).toBe("truncated answ");
  });
  it.each([undefined, "", " \n\t"])("flags empty length output %j on fresh and resumed runs (#144)", async (text) => {
    // stopReason "length" with empty content is a silent max-token death — it
    // reproduces the #144 "completed with No output." symptom, so it must fail.
    const session = sessionEnding({
      role: "assistant",
      content: text === undefined ? [] : [{ type: "text", text }],
      stopReason: "length",
    });
    const result = await execute(asAgentSession(session), "go");
    expect(result.failure).toMatch(/\S/);
    expect(result.text).toBe("");
    expect(result.interruptionCause).toBeUndefined();
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "PRIOR ANSWER" }],
    });
    const resumed = await execute(asAgentSession(session), "continue");
    expect(resumed.failure).toBe(result.failure);
    expect(resumed.text).toBe("");
    expect(resumed.interruptionCause).toBeUndefined();
  });
  it("completes fresh and resumed length stops that produced text", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated but useful answer" }],
      stopReason: "length",
    });
    const result = await execute(asAgentSession(session), "go");
    expect(result.failure).toBeUndefined();
    expect(result.text).toBe("truncated but useful answer");
    expect(result.interruptionCause).toBeUndefined();
    const resumed = await execute(asAgentSession(session), "continue");
    expect(resumed.text).toBe("truncated but useful answer");
    expect(resumed.failure).toBeUndefined();
    expect(resumed.interruptionCause).toBeUndefined();
  });
  it("does NOT flag an empty final turn that stopped cleanly (no false failures)", async () => {
    const session = sessionEnding(
      { role: "assistant", content: [{ type: "text", text: "did the work" }] },
      { role: "toolResult", content: [] },
      { role: "assistant", content: [], stopReason: "stop" },
    );
    const result = await execute(asAgentSession(session), "go");
    expect(result.failure).toBeUndefined();
    expect(result.text).toBe("did the work"); // walk-back fallback preserved
  });
  it("resume whose new turn fails empty does NOT return the previous turn's answer (#144)", async () => {
    // The session already carries a completed prior turn; the resume prompt then
    // fails empty. The walk-back must be bounded to this resume — result "".
    const { session } = createSession("");
    session.messages.push(
      { role: "user", content: "first question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "PREVIOUS ANSWER" }],
        stopReason: "stop",
      },
    );
    session.prompt.mockImplementation(async () => {
      session.messages.push({ role: "user", content: "follow-up" }, errorFinal);
    });
    const result = await execute(asAgentSession(session), "follow-up");
    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe(""); // NOT "PREVIOUS ANSWER"
  });
  it("resume that produces partial text before failing returns only THIS resume's text", async () => {
    const { session } = createSession("");
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "PREVIOUS ANSWER" }],
      stopReason: "stop",
    });
    session.prompt.mockImplementation(async () => {
      session.messages.push(
        { role: "assistant", content: [{ type: "text", text: "new partial" }] },
        { role: "toolResult", content: [] },
        errorFinal,
      );
    });
    const result = await execute(asAgentSession(session), "go");
    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe("new partial"); // this resume's progress, not the prior answer
  });
  it("collector: a toolResult/user message_start no longer wipes collected assistant text", async () => {
    const { session, listeners } = createSession("");
    session.prompt.mockImplementation(async () => {
      for (const l of listeners) {
        l({ type: "message_start", message: { role: "assistant" } });
        l({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "STREAMED" },
        });
        // pi emits message_start for tool results and queued user messages too.
        l({ type: "message_start", message: { role: "toolResult" } });
        l({ type: "message_start", message: { role: "user" } });
      }
    });
    const result = await execute(asAgentSession(session), "go");
    expect(result.text).toBe("STREAMED");
  });
});
describe("Execution usage callback wiring", () => {
  function emitMessageEnd(listeners: Array<(e: object) => void>, usage: unknown) {
    const event = {
      type: "message_end",
      message: { role: "assistant", usage },
    };
    for (const l of listeners) l(event);
  }
  it("execute forwards full usage from message_end events", async () => {
    const { session, listeners } = createSession("OK");
    const seen: Array<{
      input: number;
      output: number;
      cacheWrite: number;
    }> = [];
    session.prompt.mockImplementation(async () => {
      // Two assistant messages over the run
      emitMessageEnd(listeners, {
        input: 100,
        output: 50,
        cacheWrite: 10,
        cacheRead: 500,
        cost: { total: 0.25 },
      });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20 });
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
      });
    });
    await execute(asAgentSession(session), "go", {
      onAssistantUsage: (u) => seen.push(u),
    });
    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10, cacheRead: 500, cost: 0.25 },
      { input: 200, output: 80, cacheWrite: 20, cacheRead: 0, cost: 0 },
    ]);
  });
  it("execute normalizes partial usage objects to 0 for missing fields", async () => {
    const { session, listeners } = createSession("OK");
    const seen: object[] = [];
    session.prompt.mockImplementation(async () => {
      emitMessageEnd(listeners, { input: 50 }); // output, cacheWrite missing
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
      });
    });
    await execute(asAgentSession(session), "go", {
      onAssistantUsage: (u) => seen.push(u),
    });
    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }]);
  });
  it("execute skips the callback when message_end has no usage field", async () => {
    const { session, listeners } = createSession("OK");
    const cb = vi.fn();
    session.prompt.mockImplementation(async () => {
      emitMessageEnd(listeners, undefined);
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
      });
    });
    await execute(asAgentSession(session), "go", { onAssistantUsage: cb });
    expect(cb).not.toHaveBeenCalled();
  });
  it("resume reports completed turn_end separately from assistant usage", async () => {
    const { session, listeners } = createSession("RESUMED");
    const onTurnEnd = vi.fn();
    const onAssistantUsage = vi.fn();
    session.prompt.mockImplementation(async () => {
      emitMessageEnd(listeners, { input: 10 });
      emitMessageEnd(listeners, { input: 20 });
      expect(onTurnEnd).not.toHaveBeenCalled();
      for (const listener of listeners) listener({ type: "turn_end" });
    });
    await execute(asAgentSession(session), "continue", {
      onTurnEnd,
      onAssistantUsage,
    });
    expect(onAssistantUsage).toHaveBeenCalledTimes(2);
    expect(onTurnEnd).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("forwards compaction_end events to onCompaction (only when not aborted)", async () => {
    const { session, listeners } = createSession("OK");
    const seen: object[] = [];
    session.prompt.mockImplementation(async () => {
      // Successful compaction — should fire
      for (const l of listeners)
        l({
          type: "compaction_end",
          aborted: false,
          reason: "threshold",
          result: { tokensBefore: 12345 },
        });
      // Aborted compaction — should NOT fire
      for (const l of listeners)
        l({
          type: "compaction_end",
          aborted: true,
          reason: "manual",
          result: { tokensBefore: 99999 },
        });
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
      });
    });
    await execute(asAgentSession(session), "go", {
      onCompaction: (info) => seen.push(info),
    });
    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 12345 }]);
  });
});
it("an execution on an existing transcript gets the turn ceiling", async () => {
  vi.stubEnv("SUBAGENT_TURN_CEILING", "1");
  const { session, listeners } = createSession("DONE");
  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "prior transcript" }],
  });
  session.prompt.mockImplementation(async () => {
    for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "read", result: {} });
    for (const listener of listeners)
      listener({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", name: "read" }],
        },
        toolResults: [],
      });
  });
  const result = await execute(asAgentSession(session), "go");
  expect(session.steer).toHaveBeenCalledWith(TURN_CEILING_REMINDER);
  expect(result.forceSteered).toBe(true);
});
it("does not prompt when the parent aborted during session startup", async () => {
  const controller = new AbortController();
  const { session } = createSession("UNREACHABLE");
  const record: ExecutionRecord = {
    status: "queued",
    startedAt: 0,
    toolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    abortController: controller,
  };
  await startExecution(record).run(async () => {
    controller.abort();
    return opened(session);
  }, "go");
  expect(session.prompt).not.toHaveBeenCalled();
  expect(record.status).toBe("aborted");
  expect(record.interruptionCause).toBe("unknown");
});
const schema = {
  schema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
  providerSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
  check(value: unknown): true | string {
    return typeof value === "object" && value !== null && "answer" in value && typeof value.answer === "string"
      ? true
      : "answer must be a string";
  },
};
function structuredSession(finalText: string) {
  const child = createSession(finalText);
  const capture = createStructuredCapture();
  rememberStructuredCapture(asAgentSession(child.session), capture);
  return { ...child, tool: createStructuredOutputTool(schema, capture) };
}
it.each(["stop", "length"])("repairs %s prose once and resets capture on resume", async (stopReason) => {
  const { session, tool } = structuredSession("prose");
  let calls = 0;
  session.prompt.mockImplementation(async () => {
    calls++;
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "prose" }],
      stopReason,
    });
    if (calls === 2 || calls === 4)
      await tool.execute("result", { answer: `answer-${calls}` }, undefined, undefined, {} as never);
  });
  const result = await execute(asAgentSession(session), "answer");
  expect(result.interruptionCause).toBeUndefined();
  expect(result.structuredJson).toBe('{"answer":"answer-2"}');
  expect(result.structuredRetried).toBe(true);
  expect(result.failure).toBeUndefined();
  const resumed = await execute(asAgentSession(session), "again");
  expect(resumed.failure).toBeUndefined();
  expect(resumed.interruptionCause).toBeUndefined();
  expect(resumed.structuredJson).toBe('{"answer":"answer-4"}');
  expect(resumed.structuredRetried).toBe(true);
  expect(session.prompt).toHaveBeenCalledTimes(4);
});
it.each(["stop", "length"])(
  "fails after a single %s prose repair and does not reuse a prior answer",
  async (stopReason) => {
    const { session } = structuredSession("prose");
    session.prompt.mockImplementation(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "prose" }],
        stopReason,
      });
    });
    const result = await execute(asAgentSession(session), "answer");
    expect(result.failure).toBe(structuredFailure(createStructuredCapture()));
    expect(result.structuredJson).toBeUndefined();
    expect(result.interruptionCause).toBeUndefined();
    expect(result.structuredRetried).toBe(true);
    expect(session.prompt).toHaveBeenCalledTimes(2);
    const resumed = await execute(asAgentSession(session), "again");
    expect(resumed.failure).toBe(structuredFailure(createStructuredCapture()));
    expect(resumed.structuredJson).toBeUndefined();
    expect(resumed.interruptionCause).toBeUndefined();
    expect(resumed.structuredRetried).toBe(true);
    expect(session.prompt).toHaveBeenCalledTimes(4);
  },
);
it("validates payloads with a model-visible tool error", async () => {
  const { session, tool } = structuredSession("prose");
  session.prompt.mockImplementation(async () => {
    await expect(tool.execute("bad", { answer: 5 }, undefined, undefined, {} as never)).rejects.toThrow(
      "answer must be a string",
    );
    await tool.execute("good", { answer: "validated" }, undefined, undefined, {} as never);
  });
  const result = await execute(asAgentSession(session), "answer");
  expect(result.structuredJson).toBe('{"answer":"validated"}');
  expect(result.structuredRetried).toBe(false);
  expect(session.prompt).toHaveBeenCalledTimes(1);
});
it.each(["sdk", "signal", "turn-limit"])("suppresses structured repair after %s interruption", async (kind) => {
  const { session, listeners } = structuredSession("checkpoint");
  const controller = new AbortController();
  session.prompt.mockImplementation(async () => {
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "checkpoint" }],
      stopReason: kind === "sdk" ? "aborted" : "length",
    });
    if (kind === "signal") controller.abort();
    if (kind === "turn-limit") {
      for (let turn = 0; turn < 10 && !session.abort.mock.calls.length; turn++) {
        for (const listener of listeners)
          listener({
            type: "turn_end",
            message: {
              role: "assistant",
              stopReason: "toolUse",
              content: [{ type: "toolCall", name: "read" }],
            },
            toolResults: [],
          });
      }
    }
  });
  if (kind === "turn-limit") vi.stubEnv("SUBAGENT_TURN_CEILING", "1");
  const result = await execute(asAgentSession(session), "answer", {
    signal: controller.signal,
  });
  expect(result.interruptionCause).toBe(kind === "turn-limit" ? "turn-limit" : "unknown");
  expect(result.structuredRetried).toBe(false);
  expect(session.prompt).toHaveBeenCalledTimes(1);
  if (kind !== "turn-limit") {
    const resumed = await execute(asAgentSession(session), "again", {
      signal: controller.signal,
    });
    expect(resumed.interruptionCause).toBe("unknown");
    expect(resumed.structuredRetried).toBe(false);
    expect(session.prompt).toHaveBeenCalledTimes(kind === "sdk" ? 2 : 1);
  }
});
it("never prompts a pre-aborted structured session", async () => {
  const { session } = structuredSession("prose");
  const result = await execute(asAgentSession(session), "answer", {
    signal: AbortSignal.abort(),
  });
  expect(result.interruptionCause).toBe("unknown");
  expect(session.prompt).not.toHaveBeenCalled();
  await execute(asAgentSession(session), "again", {
    signal: AbortSignal.abort(),
  });
  expect(session.prompt).not.toHaveBeenCalled();
});
it("forwards real tool completions separately from setup diagnostics", async () => {
  const session = fakeSession((_prompt, child) => {
    child.toolEnd("read");
    return "DONE";
  });
  const activities: Array<{
    type: string;
    toolName: string;
  }> = [];
  const record: ExecutionRecord = {
    status: "queued",
    startedAt: 0,
    toolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  await startExecution(record, {
    onToolActivity: (activity) => activities.push(activity),
  }).run(async (setup) => {
    setup.onToolActivity({
      type: "diagnostic",
      toolName: "tools-warning:missing-extension",
    });
    return opened(session);
  }, "go");
  expect(activities.filter((activity) => activity.type === "end")).toEqual([{ type: "end", toolName: "read" }]);
  expect(record.toolUses).toBe(1);
  expect(record.diagnostics).toEqual(["tools-warning:missing-extension"]);
});
