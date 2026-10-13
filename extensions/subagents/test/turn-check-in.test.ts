/**
 * turn-check-in.test.ts — the orchestrator check-in through the real `agent`,
 * `get_agent_result`, and notification wiring: a waiting retrieval returns early,
 * a foreground call (fresh, live resume, or evicted resume) converts to
 * background, and an unobserved check-in sends one follow-up notification.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS, getBackgroundSupervisionAction } from "../src/background-supervision.js";
import { turnCheckInNotice } from "../src/turn-ceiling.js";
import type { AgentRecord } from "../src/types.js";
import { boot, dir, mockSessions } from "./graph-run-registration.fixture.js";
import { deferred } from "./helpers/session-seam.js";

type Host = ReturnType<typeof boot>;
interface Registry {
  getRecord(id: string): AgentRecord | undefined;
  spawn(pi: unknown, ctx: ExtensionContext, type: string, prompt: string, options: Record<string, unknown>): string;
}

/** The stubbed check-in threshold; a run's unfinished turns reach it. */
const CHECK_IN = 2;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";
const registry = () => (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as Registry;
const settle = () => new Promise(resolve => setTimeout(resolve, 350));

interface ParkedRun {
  release(): void;
  /** Run unfinished turns up to the check-in threshold. */
  checkIn(): void;
}

/** Every prompt parks until released; the test fires its check-in. */
function parkRuns() {
  vi.stubEnv("SUBAGENT_TURN_CHECK_IN", String(CHECK_IN));
  const runs: ParkedRun[] = [];
  mockSessions(async (prompt, session) => {
    const drain = deferred();
    runs.push({
      release: () => drain.resolve(),
      checkIn: () => { for (let turn = 0; turn < CHECK_IN; turn++) session.turn(true); },
    });
    await drain.promise;
    return `${prompt} answer`;
  }, { messages: [{ role: "user", content: "inspect the repo", timestamp: 0 }] });
  return runs;
}

/** Fire run `index`'s check-in once its prompt is running. */
async function checkIn(runs: ParkedRun[], index: number) {
  await vi.waitFor(() => expect(runs[index]).toBeDefined());
  runs[index]?.checkIn();
}

async function launchBackground(host: Host, toolCallId = "tc-bg") {
  const result = await host.tools.get("agent")?.execute(toolCallId, { prompt: "inspect", description: "inspect repo", subagent_type: "fixture", run_in_background: true }, undefined, undefined, host.ctx);
  const id = /Agent ID: (\S+)/.exec(textOf(result ?? { content: [] }))?.[1];
  if (!id) throw new Error("No background agent id");
  return id;
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
      await checkIn(runs, 0);
      const text = textOf(await waiting ?? { content: [] });
      expect(text.startsWith(`${turnCheckInNotice({ id, description: "inspect repo" }, CHECK_IN)}\n\nAgent: ${id}\n`)).toBe(true);
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
      await checkIn(runs, 0);
      await checkIn(runs, 1);
      await settle();
      expect(checkInMessages(host)).toHaveLength(1);
      const [message, options] = checkInMessages(host)[0] ?? [];
      expect(message).toMatchObject({ customType: "subagent-notification", content: turnCheckInNotice({ id, description: "inspect repo" }, CHECK_IN), display: true, details: { id, status: "running" } });
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
      await checkIn(runs, 0);
      const result = await foreground;
      const id = /Agent ID: (\S+)/.exec(textOf(result ?? { content: [] }))?.[1] ?? "";
      const text = textOf(result ?? { content: [] });
      expect(text.startsWith(turnCheckInNotice({ id, description: "audit repo" }, CHECK_IN, true))).toBe(true);
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
    const runs = parkRuns();
    const host = boot();
    const agent = host.tools.get("agent");
    let convertedRecord: AgentRecord | undefined;
    const foreground = agent?.execute("tc-convert", { prompt: "audit", description: "audit repo", subagent_type: "fixture" }, undefined, undefined, host.ctx);
    try {
      await checkIn(runs, 0);
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
    } finally { for (const run of runs) run.release(); await convertedRecord?.promise; }
  });

  it("converts a foreground live resume at the check-in; its completion arrives as a background notification", async () => {
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "1");
    const drain = deferred();
    // The spawn answers at once; the resume runs one unfinished tool turn, then parks.
    mockSessions(async (prompt, session) => {
      if (prompt === "audit") return `${prompt} answer`;
      // A real first turn is asynchronous; the foreground caller is waiting by then.
      await new Promise(resolve => setTimeout(resolve, 10));
      session.turn(true);
      await drain.promise;
      return `${prompt} answer`;
    });
    const host = boot();
    const agent = host.tools.get("agent");
    const first = await agent?.execute("tc-first", { prompt: "audit", description: "audit repo", subagent_type: "fixture" }, undefined, undefined, host.ctx);
    const id = /Agent ID: (\S+)/.exec(textOf(first ?? { content: [] }))?.[1] ?? "";
    try {
      const resumed = await agent?.execute("tc-resume", { prompt: "continue", description: "continue audit", subagent_type: "fixture", resume: id }, undefined, undefined, host.ctx);
      expectConverted(resumed, { id, description: "audit repo" }, 1, "tc-resume");
      drain.resolve();
      const completion = await host.notification(id);
      expect(completion.content).toContain("continue answer");
      expect(completion.content).toContain("<tool-use-id>tc-resume</tool-use-id>");
    } finally { drain.resolve(); }
  });

  it("converts a foreground evicted resume at the check-in; its completion arrives as a background notification", async () => {
    const runs = parkRuns();
    const host = await bootIndexed();
    const resuming = host.tools.get("agent")?.execute("tc-restore", { prompt: "again", description: "resume", subagent_type: "fixture", resume: "evicted-1" }, undefined, undefined, host.ctx);
    try {
      await checkIn(runs, 0);
      expectConverted(await resuming, { id: "evicted-1", description: "evicted review" }, CHECK_IN, "tc-restore");
      runs[0]?.release();
      const completion = await host.notification("evicted-1");
      expect(completion.content).toContain("again answer");
      expect(completion.content).toContain("<tool-use-id>tc-restore</tool-use-id>");
    } finally { for (const run of runs) run.release(); }
  });
});
