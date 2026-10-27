import { mkdtempSync as tempDir, rmSync as removeDir } from "node:fs";
import { tmpdir as tempRoot } from "node:os";
import { join as pathJoin } from "node:path";
import { beforeEach as fixtureBefore, afterEach as fixtureAfter } from "vitest";
import { writeFixtureAgent } from "./helpers/fixture-agent.js";
/**
 * wait-queued.test.ts — get_agent_result(wait: true) lifecycle behavior.
 *
 * Queued records have no promise yet (it's created when the queue starts
 * them), so the old `status === "running" && record.promise` condition
 * skipped the wait entirely and returned "still running" — forcing the
 * caller into a poll loop against the concurrency queue.
 *
 * Wiring test through the REAL extension: spawn background agents until one
 * queues, call the real tool with wait:true, drain the queue, and assert the
 * call returns the final result.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async (importOriginal) =>
  (await import("./helpers/session-seam.js")).mockOpenSession(await importOriginal()));

import { openSession } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { QUEUE_WAIT_POLL_MS } from "../src/notification-coordinator.js";
import { deferred, fakeSession, opened } from "./helpers/session-seam.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** Each session prompt blocks until we resolve it manually. */
function deferredRuns() {
  const resolvers: Array<() => void> = [];
  vi.mocked(openSession).mockImplementation(async () => {
    const gate = deferred<string>();
    resolvers.push(() => gate.resolve("THE-RESULT-PAYLOAD"));
    return opened(fakeSession(() => gate.promise));
  });
  return resolvers;
}

async function spawnBackground(tools: Map<string, any>): Promise<{ id: string; queued: boolean }> {
  const r = await tools.get("agent").execute(
    "tc-spawn",
    { prompt: "go", description: "queued-wait test agent", subagent_type: "fixture", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
  return { id, queued: textOf(r).includes("queued in background") };
}

describe("get_agent_result wait:true on a queued agent", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queued_retrieval_retains_default_intent_without_claiming_actual_thinking", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const resolvers = deferredRuns();
    try {
      let queuedId: string | undefined;
      for (let i = 0; i < 10 && !queuedId; i++) {
        const { id, queued } = await spawnBackground(tools);
        if (queued) queuedId = id;
      }
      expect(queuedId).toBeDefined();
      const pending = await tools.get("get_agent_result").execute("pending", { run_id: queuedId, wait: false }, undefined, undefined, ctx());
      expect(pending.details).toMatchObject({ status: "queued", thinking: undefined, tags: expect.arrayContaining(["thinking: default (pending)"]) });
      const agentCwd = mkdtempSync(join(tmpdir(), "wait-queued-explicit-"));
      mkdirSync(join(agentCwd, ".pi", "agents"), { recursive: true });
      writeFileSync(join(agentCwd, ".pi", "agents", "explicit-thinker.md"), "---\ndescription: Explicit\nthinking: high\n---\nReport.\n");
      const prevCwd = process.cwd();
      process.chdir(agentCwd);
      try {
        const explicit = await tools.get("agent").execute("explicit", { prompt: "go", description: "explicit", subagent_type: "explicit-thinker", run_in_background: true }, undefined, undefined, ctx());
        const retrieved = await tools.get("get_agent_result").execute("explicit-pending", { run_id: explicit.details.agentId, wait: false }, undefined, undefined, ctx());
        expect(retrieved.details).toMatchObject({ status: "queued", thinking: undefined, tags: expect.not.arrayContaining(["thinking: default (pending)"]) });
      } finally {
        process.chdir(prevCwd);
        rmSync(agentCwd, { recursive: true, force: true });
      }
    } finally {
      let settled = false;
      const shutdown = Promise.resolve(lifecycle.get("session_shutdown")?.()).then(() => { settled = true; });
      try {
        await flush();
        expect(settled).toBe(false); // shutdown must wait for the parked runners
      } finally {
        while (resolvers.length) resolvers.shift()?.();
        await shutdown;
      }
    }
  });

  it("waits through queue start and returns the result (no 'still running')", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();

    // Spawn until one lands in the queue (concurrency limit is config-dependent).
    let queuedId: string | undefined;
    for (let i = 0; i < 10 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 10 spawns").toBeDefined();

    // wait:true on the QUEUED agent — must not return "still running".
    const waitPromise = tools
      .get("get_agent_result")
      .execute("tc-wait", { run_id: queuedId, wait: true }, undefined, undefined, ctx());

    // Drain: resolve running agents until the queued one starts and finishes.
    let settled = false;
    void waitPromise.then(() => { settled = true; });
    for (let i = 0; i < 40 && !settled; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      await vi.advanceTimersByTimeAsync(QUEUE_WAIT_POLL_MS); // one queue poll tick
    }

    const result = await waitPromise;
    expect(textOf(result)).toContain("THE-RESULT-PAYLOAD");
    expect(textOf(result)).not.toContain("still running");

    await vi.runOnlyPendingTimersAsync(); // batch debounce and notification hold
    expect(JSON.stringify(pi.sendMessage.mock.calls)).not.toContain(queuedId);

    await lifecycle.get("session_shutdown")?.();
  }, 20_000);

  it("aborts a running result wait without aborting or consuming the child", async () => {
    // The smart-join batch debounce is armed at spawn, so timers are faked from the start.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const completed = new Promise<void>((resolve) => {
      pi.events.emit.mockImplementation((name: string) => { if (name === "subagents:completed") resolve(); });
    });

    const gate = deferred<string>();
    const session = fakeSession(() => gate.promise);
    vi.mocked(openSession).mockResolvedValue(opened(session));

    const { id } = await spawnBackground(tools);
    await flush();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waitOutcome = tools
      .get("get_agent_result")
      .execute("tc-wait-abort", { run_id: id, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    const childWasAborted = session.abort.mock.calls.length > 0;

    gate.resolve("THE-RESULT-PAYLOAD");
    await flush();
    await waitOutcome;
    await completed;
    await vi.runOnlyPendingTimersAsync(); // smart-join batch debounce schedules the held nudge
    await vi.runOnlyPendingTimersAsync(); // the nudge hold elapses

    const completedResult = await tools
      .get("get_agent_result")
      .execute("tc-result", { run_id: id }, undefined, undefined, ctx());

    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(childWasAborted).toBe(false);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");
  });

  it("aborts a queued result wait before the agent starts", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    let queuedId: string | undefined;
    for (let i = 0; i < 10 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 10 spawns").toBeDefined();

    const controller = new AbortController();
    const waitOutcome = tools
      .get("get_agent_result")
      .execute("tc-queued-abort", { run_id: queuedId, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    let completedResult: any;
    for (let i = 0; i < 40 && !completedResult; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      const result = await tools
        .get("get_agent_result")
        .execute("tc-queued-result", { run_id: queuedId }, undefined, undefined, ctx());
      if (textOf(result).includes("THE-RESULT-PAYLOAD")) completedResult = result;
      await new Promise((r) => setTimeout(r, 25));
    }

    await waitOutcome;
    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");
  });
});

let fixtureCwd: string;
let originalCwd: string;
fixtureBefore(() => {
  originalCwd = process.cwd();
  fixtureCwd = tempDir(pathJoin(tempRoot(), "subagent-fixture-"));
  writeFixtureAgent(fixtureCwd);
  process.chdir(fixtureCwd);
});
fixtureAfter(() => {
  process.chdir(originalCwd);
  removeDir(fixtureCwd, { recursive: true, force: true });
});
