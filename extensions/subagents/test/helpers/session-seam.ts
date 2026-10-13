/**
 * session-seam.ts — the shared session-seam fake for manager-level tests.
 *
 * Tests mock only `openSession` (src/agent-runner.ts) and keep every other real
 * export, so the real AgentManager, Execution, and turn watch run against a
 * fake AgentSession. Each prompt runs the session's script, then ends with the
 * script's reply as the final assistant message. Scripts drive the SDK events
 * an Execution observes; nothing here pins prose.
 *
 *   vi.mock("../src/agent-runner.js", async (importOriginal) =>
 *     (await import("./helpers/session-seam.js")).mockOpenSession(await importOriginal()));
 *   import { openSession } from "../src/agent-runner.js";
 *   vi.mocked(openSession).mockResolvedValueOnce(opened(fakeSession(() => "done")));
 *
 * The session is opened before the prompt runs: `await flush()` after a spawn
 * before asserting on prompts, tool activity, or anything the prompt does.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Mock, vi } from "vitest";
import type { openSession } from "../../src/agent-runner.js";
import type { OpenedSession } from "../../src/execution.js";
import { createStructuredCapture, rememberStructuredCapture, type StructuredCapture } from "../../src/structured-output.js";

/** A usage delta as an Execution reports it; absent fields read as 0. */
export interface UsageDelta {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  cost?: number;
}

/** How a prompt ends. A script that throws rejects the prompt instead. */
export interface Reply {
  /** Final assistant text. */
  text?: string;
  /** Provider failure: stopReason "error" with this errorMessage. */
  failure?: string;
  /** SDK abort: stopReason "aborted". */
  aborted?: boolean;
  /** Usage reported on the final assistant message. */
  usage?: UsageDelta;
}

/** What a prompt script may drive on its session. */
export interface ScriptedSession {
  model: { provider: string; id: string } | undefined;
  thinkingLevel: string;
  messages: object[];
  /** Resolves once the Execution forwards an abort to the session. */
  aborted: Promise<void>;
  emit(event: object): void;
  reply(reply: Reply): void;
  usage(delta: UsageDelta): void;
  textDelta(delta: string): void;
  thinkingDelta(delta: string): void;
  argumentDelta(delta: string): void;
  toolStart(toolName: string): void;
  toolEnd(toolName: string, terminate?: boolean): void;
  compaction(info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }, aborted?: boolean): void;
  turn(unfinished?: boolean): void;
  holdIdle(): () => void;
  structuredOutput(value: unknown): void;
}

/** Runs on each prompt; a string is the final text, nothing means no final message. */
export type Script = (prompt: string, session: ScriptedSession) => Reply | string | undefined | Promise<Reply | string | undefined>;

export interface FakeSessionInit {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  /** Persisted child session file; the manager records it as `record.sessionFile`. */
  sessionFile?: string;
  /** Remember a StructuredOutput capture for this session (`structuredOutput()` fills it). */
  structured?: boolean;
  /** Messages already in the session, such as a reopened transcript. */
  messages?: object[];
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let an opened session reach its prompt (the session is awaited before the Execution prompts). */
export async function flush(ticks = 20): Promise<void> {
  for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
}

function messageUsage(delta: UsageDelta) {
  const usage = { input: delta.input ?? 0, output: delta.output ?? 0, cacheRead: delta.cacheRead ?? 0, cacheWrite: delta.cacheWrite ?? 0 };
  return { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite, cost: { total: delta.cost ?? 0 } };
}

/** createSession-shaped fake (agent-runner.test.ts) whose prompts run `script`; by default it answers with the prompt. */
export function fakeSession(script: Script = (prompt) => prompt, init: FakeSessionInit = {}) {
  const listeners: Array<(event: object) => void> = [];
  let idle: Promise<void> | undefined;
  let messageStarted = false;
  let streamedText = "";
  function startMessage() {
    if (messageStarted) return;
    messageStarted = true;
    session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
  }
  const aborted = deferred();
  const capture: StructuredCapture | undefined = init.structured ? createStructuredCapture() : undefined;
  const session = {
    model: init.model ?? { provider: "test", id: "chosen" } as { provider: string; id: string } | undefined,
    thinkingLevel: init.thinkingLevel ?? "low",
    messages: [...(init.messages ?? [])] as object[],
    sessionManager: init.sessionFile
      ? { isPersisted: () => true, getSessionFile: () => init.sessionFile }
      : { isPersisted: () => false, getSessionFile: () => undefined },
    capture,
    /** Resolves once the Execution forwards an abort to the session. */
    aborted: aborted.promise,
    subscribe: vi.fn((listener: (event: object) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    prompt: vi.fn(async (text: string): Promise<void> => {
      messageStarted = false;
      streamedText = "";
      const reply = await script(text, session);
      if (reply !== undefined) session.reply(typeof reply === "string" ? { text: reply } : reply);
    }),
    waitForIdle: vi.fn((): Promise<void> => idle ?? Promise.resolve()),
    abort: vi.fn(async () => { aborted.resolve(); }),
    steer: vi.fn(async (_message: string) => {}),
    dispose: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    getAllTools: vi.fn(() => []),
    getActiveToolNames: vi.fn(() => []),
    setActiveToolsByName: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    agent: {},
    emit(event: object) {
      for (const listener of [...listeners]) listener(event);
    },
    /** Append the final assistant message of a prompt, with its start and end events. */
    reply(reply: Reply) {
      const message = {
        role: "assistant",
        content: (reply.text ?? streamedText) ? [{ type: "text", text: reply.text ?? streamedText }] : [],
        stopReason: reply.aborted ? "aborted" : reply.failure !== undefined ? "error" : "stop",
        ...(reply.failure !== undefined && { errorMessage: reply.failure }),
        ...(reply.usage && { usage: messageUsage(reply.usage) }),
        provider: session.model?.provider,
        model: session.model?.id,
      };
      startMessage();
      session.messages.push(message);
      session.emit({ type: "message_end", message });
      messageStarted = false;
      streamedText = "";
    },
    /** An assistant message carrying only this usage. */
    usage(delta: UsageDelta) {
      session.emit({ type: "message_end", message: { role: "assistant", content: [], usage: messageUsage(delta) } });
    },
    textDelta(delta: string) {
      startMessage();
      streamedText += delta;
      session.emit({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta } });
    },
    thinkingDelta(delta: string) {
      startMessage();
      session.emit({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta", delta } });
    },
    argumentDelta(delta: string) {
      startMessage();
      session.emit({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "toolcall_delta", delta } });
    },
    toolStart(toolName: string) {
      session.emit({ type: "tool_execution_start", toolName });
    },
    toolEnd(toolName: string, terminate = false) {
      session.emit({ type: "tool_execution_end", toolName, result: terminate ? { terminate: true } : {} });
    },
    compaction(info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }, abortedCompaction = false) {
      session.emit({ type: "compaction_end", reason: info.reason, aborted: abortedCompaction, result: { tokensBefore: info.tokensBefore } });
    },
    /** One turn; an unfinished one (a tool call) counts toward the check-in and turn ceiling. */
    turn(unfinished = false) {
      session.emit({
        type: "turn_end",
        message: unfinished
          ? { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] }
          : { role: "assistant", stopReason: "stop", content: [] },
        toolResults: [],
      });
    },
    /** Hold `waitForIdle` (deferred drain); returns the release. */
    holdIdle(): () => void {
      const drained = deferred();
      idle = drained.promise;
      return () => {
        idle = undefined;
        drained.resolve();
      };
    },
    /** Record a valid StructuredOutput payload on the remembered capture. */
    structuredOutput(value: unknown) {
      if (!capture) throw new Error("fakeSession was not created with structured: true");
      capture.called = true;
      capture.json = JSON.stringify(value);
    },
  };
  if (capture) rememberStructuredCapture(session as unknown as AgentSession, capture);
  return session;
}

export type FakeSession = ReturnType<typeof fakeSession>;

/** The `openSession` result for a fake session. */
export function opened(session: FakeSession, promptPrefix?: string): OpenedSession {
  return { session: session as unknown as AgentSession, promptPrefix };
}

/** The fake as the AgentSession type the manager stores (`record.session`). */
export function asAgentSession(session: FakeSession): AgentSession {
  return session as unknown as AgentSession;
}

export type OpenSessionMock = Mock<typeof openSession>;

/**
 * `vi.mock` factory for src/agent-runner.ts: the real exports, with
 * `openSession` mocked to open a fresh `fakeSession()` (it answers with the prompt).
 */
export function mockOpenSession<T extends object>(actual: T): T & { openSession: OpenSessionMock } {
  return { ...actual, openSession: vi.fn<typeof openSession>(async () => opened(fakeSession())) };
}
