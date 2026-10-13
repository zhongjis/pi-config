/**
 * turn-check-in.test.ts — the orchestrator check-in through the real `agent`,
 * `get_agent_result`, and notification wiring: a waiting retrieval returns early,
 * a foreground call (fresh, live resume, or evicted resume) converts to
 * background, and an unobserved check-in sends one follow-up notification.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { RunOptions } from "../src/agent-runner.js";
import { DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS, getBackgroundSupervisionAction } from "../src/background-supervision.js";
import { turnCheckInNotice } from "../src/turn-ceiling.js";
import type { AgentRecord } from "../src/types.js";
import { boot, dir, mockRunAgent, session } from "./graph-run-registration.fixture.js";

type Host = ReturnType<typeof boot>;
interface Registry {
  getRecord(id: string): AgentRecord | undefined;
  spawn(pi: unknown, ctx: ExtensionContext, type: string, prompt: string, options: Record<string, unknown>): string;
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";
const registry = () => (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as Registry;
const messages: AgentSession["messages"] = [{ role: "user", content: "inspect the repo", timestamp: 0 }];
const liveFixture: Partial<AgentSession> = { ...session, messages };
const live = liveFixture as AgentSession;
const settle = () => new Promise(resolve => setTimeout(resolve, 350));

/** Every run parks until released; the test triggers its check-in. */
function parkRuns(childSession = live) {
  const runs: { options: RunOptions; release: () => void }[] = [];
  mockRunAgent(async (_ctx, _type, prompt, options) => {
    let release = () => {};
    const drain = new Promise<void>(resolve => { release = resolve; });
    runs.push({ options, release: () => release() });
    options.onSessionCreated?.(childSession);
    await drain;
    return { responseText: `${prompt} answer`, session: childSession, aborted: false, forceSteered: false };
  });
  return runs;
}

function checkIn(run: { options: RunOptions } | undefined, threshold = 150) {
  if (!run?.options.onCheckIn) throw new Error("No check-in callback");
  run.options.onCheckIn(threshold);
}

async function launchBackground(host: Host, toolCallId = "tc-bg") {
  const result = await host.tools.get("agent")?.execute(toolCallId, { prompt: "inspect", description: "inspect repo", subagent_type: "fixture", run_in_background: true }, undefined, undefined, host.ctx);
  const id = /Agent ID: (\S+)/.exec(textOf(result ?? { content: [] }))?.[1];
  if (!id) throw new Error("No background agent id");
  return id;
}

/** A live session whose next prompt runs one unfinished tool turn, then parks until released. */
function scriptedSession() {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  let release = () => {};
  const drain = new Promise<void>(resolve => { release = resolve; });
  const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
    role: "assistant", content, stopReason, api: "anthropic-messages", provider: "test", model: "chosen", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const messages: AgentSession["messages"] = [];
  const fixture: Partial<AgentSession> = {
    ...session,
    messages,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    },
    waitForIdle: async () => {},
    prompt: async (text) => {
      // A real first turn is asynchronous; the foreground caller is waiting by then.
      await new Promise(resolve => setTimeout(resolve, 10));
      const turn: AgentSessionEvent = { type: "turn_end", message: assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], "toolUse"), toolResults: [] };
      for (const listener of [...listeners]) listener(turn);
      await drain;
      messages.push(assistant([{ type: "text", text: `${text} answer` }], "stop"));
    },
  };
  return { session: fixture as AgentSession, release: () => release() };
}

/** Index one evicted run in the owning activation's agent history, then start it. */
async function bootIndexed() {
  const sessionFile = join(dir, "global", "subagent-sessions", "parent", "child.jsonl");
  const historyPath = join(dir, "global", "local", "parent", "agent-history.json");
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, "synthetic\n");
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, JSON.stringify({ version: 1, runs: [{
    id: "evicted-1", type: "fixture", description: "evicted review", status: "completed",
    startedAt: 1, completedAt: 2, toolUses: 3, lifetimeUsage: { input: 100, output: 20, cacheWrite: 30 }, sessionFile,
  }] }));
  const host = boot();
  await host.lifecycle("session_start");
  return host;
}

/** A converted foreground call: the foreground notice and background-launch lines, and a running background record. */
function expectConverted(result: { content: Array<{ type: string; text?: string }> } | undefined, record: { id: string; description: string }, threshold: number, toolCallId: string) {
  const text = textOf(result ?? { content: [] });
  expect(text.startsWith(`${turnCheckInNotice(record, threshold, true)}\n\nAgent ID: ${record.id}\n`)).toBe(true);
  expect(text).toContain("call get_agent_result with run_id and wait: true");
  expect(text).toContain("steer_subagent");
  expect(registry().getRecord(record.id)).toMatchObject({ status: "running", isBackground: true, invocation: { runInBackground: true }, toolCallId });
}

const checkInMessages = (host: Host) => host.api.sendMessage.mock.calls.filter(([message]) => message.customType === "subagent-notification" && message.details?.status === "running");

describe("orchestrator turn check-in", () => {
  it("returns a waiting get_agent_result at the check-in without consuming completion; verbose reads the running conversation", async () => {
    const runs = parkRuns();
    const host = boot();
    const id = await launchBackground(host);
    try {
      const retrieve = host.tools.get("get_agent_result");
      const waiting = retrieve?.execute("tc-wait", { run_id: id, wait: true }, undefined, undefined, host.ctx);
      checkIn(runs[0]);
      const text = textOf(await waiting ?? { content: [] });
      expect(text.startsWith(`${turnCheckInNotice({ id, description: "inspect repo" }, 150)}\n\nAgent: ${id}\n`)).toBe(true);
      expect(text).toContain("Agent execution is still pending.");
      expect(registry().getRecord(id)?.resultConsumed).toBe(false);

      const verbose = textOf(await retrieve?.execute("tc-verbose", { run_id: id, verbose: true }, undefined, undefined, host.ctx) ?? { content: [] });
      expect(verbose).toContain("Agent execution is still pending.");
      expect(verbose).toContain("--- Agent Conversation ---");
      expect(verbose).toContain("[User]: inspect the repo");

      // A woken waiter is the only delivery; completion still arrives as a notification.
      runs[0]?.release();
      expect((await host.notification(id)).content).toContain("inspect answer");
      await settle();
      expect(checkInMessages(host)).toHaveLength(0);
    } finally { for (const run of runs) run.release(); }
  });

  it("sends one held follow-up when no waiter is active, and none for untracked RPC spawns", async () => {
    const runs = parkRuns();
    const host = boot();
    const id = await launchBackground(host);
    const rpcId = registry().spawn({}, host.ctx, "fixture", "rpc", { description: "rpc run", isBackground: true });
    try {
      checkIn(runs[0]);
      checkIn(runs[1]);
      await settle();
      expect(checkInMessages(host)).toHaveLength(1);
      const [message, options] = checkInMessages(host)[0] ?? [];
      expect(message).toMatchObject({ customType: "subagent-notification", content: turnCheckInNotice({ id, description: "inspect repo" }, 150), display: true, details: { id, status: "running" } });
      expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
      expect(JSON.stringify(host.api.sendMessage.mock.calls)).not.toContain(rpcId);
    } finally { for (const run of runs) run.release(); }
  });

  it("converts a foreground call to background; completion arrives as a notification and the foreground slot stays held until Settlement", async () => {
    const runs = parkRuns();
    const host = boot({ maxConcurrentForeground: 1 });
    const agent = host.tools.get("agent");
    const foreground = agent?.execute("tc-fg", { prompt: "audit", description: "audit repo", subagent_type: "fixture" }, undefined, undefined, host.ctx);
    let next: ReturnType<NonNullable<typeof agent>["execute"]> | undefined;
    try {
      await expect.poll(() => runs.length).toBe(1);
      checkIn(runs[0]);
      const result = await foreground;
      const id = /Agent ID: (\S+)/.exec(textOf(result ?? { content: [] }))?.[1] ?? "";
      const text = textOf(result ?? { content: [] });
      expect(text.startsWith(turnCheckInNotice({ id, description: "audit repo" }, 150, true))).toBe(true);
      expect(text).toContain(`Agent ID: ${id}`);
      expect(text).toContain("call get_agent_result with run_id and wait: true");
      expect(text).toContain("steer_subagent");
      expect(result?.details).toMatchObject({ status: "background" });
      expect(registry().getRecord(id)).toMatchObject({ status: "running", isBackground: true, invocation: { runInBackground: true }, toolCallId: "tc-fg", joinMode: "smart" });

      next = agent?.execute("tc-next", { prompt: "next", description: "next task", subagent_type: "fixture" }, undefined, undefined, host.ctx);
      await settle();
      expect(runs).toHaveLength(1);

      runs[0]?.release();
      const completion = await host.notification(id);
      expect(completion.content).toContain("audit answer");
      expect(completion.content).toContain("<tool-use-id>tc-fg</tool-use-id>");
      await expect.poll(() => runs.length).toBe(2);
      runs[1]?.release();
      expect(textOf(await next ?? { content: [] })).toContain("next answer");
    } finally { for (const run of runs) run.release(); await next; }
  });

  it("keeps a converted Execution unsupervised past the ceiling, but supervises its next background resume", async () => {
    const scripted = scriptedSession();
    const runs = parkRuns(scripted.session);
    const host = boot();
    const agent = host.tools.get("agent");
    let convertedRecord: AgentRecord | undefined;
    const foreground = agent?.execute("tc-convert", { prompt: "audit", description: "audit repo", subagent_type: "fixture" }, undefined, undefined, host.ctx);
    try {
      await expect.poll(() => runs.length).toBe(1);
      checkIn(runs[0]);
      const id = /Agent ID: (\S+)/.exec(textOf(await foreground ?? { content: [] }))?.[1] ?? "";
      const record = registry().getRecord(id);
      if (!record) throw new Error("No converted record");
      convertedRecord = record;
      record.startedAt = Date.now() - DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS - 1;
      expect(record).toMatchObject({ status: "running", isBackground: true, convertedAtCheckIn: true });
      expect(getBackgroundSupervisionAction({ record, now: Date.now() }).action).toBe("none");

      runs[0]?.release();
      await record.promise;
      const priorExecution = record.executionId;
      await agent?.execute("tc-bg-resume", { prompt: "continue", description: "continue audit", subagent_type: "fixture", resume: id, run_in_background: true }, undefined, undefined, host.ctx);
      expect(registry().getRecord(id)).toBe(record);
      expect(record.executionId).not.toBe(priorExecution);
      expect(record).toMatchObject({ status: "running", isBackground: true });
      expect(record.convertedAtCheckIn).toBeUndefined();
      expect(getBackgroundSupervisionAction({ record, now: record.startedAt + DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS }))
        .toMatchObject({ action: "abort", reasonClass: "ceiling" });
    } finally { for (const run of runs) run.release(); scripted.release(); await convertedRecord?.promise; }
  });

  it("converts a foreground live resume at the check-in; its completion arrives as a background notification", async () => {
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "1");
    const scripted = scriptedSession();
    mockRunAgent(async (_ctx, _type, prompt, options) => {
      options.onSessionCreated?.(scripted.session);
      return { responseText: `${prompt} answer`, session: scripted.session, aborted: false, forceSteered: false };
    });
    const host = boot();
    const agent = host.tools.get("agent");
    const first = await agent?.execute("tc-first", { prompt: "audit", description: "audit repo", subagent_type: "fixture" }, undefined, undefined, host.ctx);
    const id = /Agent ID: (\S+)/.exec(textOf(first ?? { content: [] }))?.[1] ?? "";
    try {
      const resumed = await agent?.execute("tc-resume", { prompt: "continue", description: "continue audit", subagent_type: "fixture", resume: id }, undefined, undefined, host.ctx);
      expectConverted(resumed, { id, description: "audit repo" }, 1, "tc-resume");
      scripted.release();
      const completion = await host.notification(id);
      expect(completion.content).toContain("continue answer");
      expect(completion.content).toContain("<tool-use-id>tc-resume</tool-use-id>");
    } finally { scripted.release(); }
  });

  it("converts a foreground evicted resume at the check-in; its completion arrives as a background notification", async () => {
    const runs = parkRuns();
    const host = await bootIndexed();
    const resuming = host.tools.get("agent")?.execute("tc-restore", { prompt: "again", description: "resume", subagent_type: "fixture", resume: "evicted-1" }, undefined, undefined, host.ctx);
    try {
      await expect.poll(() => runs.length).toBe(1);
      checkIn(runs[0]);
      expectConverted(await resuming, { id: "evicted-1", description: "evicted review" }, 150, "tc-restore");
      runs[0]?.release();
      const completion = await host.notification("evicted-1");
      expect(completion.content).toContain("again answer");
      expect(completion.content).toContain("<tool-use-id>tc-restore</tool-use-id>");
    } finally { for (const run of runs) run.release(); }
  });
});
