/**
 * agent-resume-evicted.test.ts — AgentManager.restoreEvicted: resuming a run
 * that left the live map (retention cleanup, clearCompleted, or reload) from
 * its persisted session file, and every refusal before a record exists.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async (importOriginal) =>
  (await import("./helpers/session-seam.js")).mockOpenSession(await importOriginal()));

import { AgentManager } from "../src/agent-manager.js";
import { openSession } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, EvictedAgent } from "../src/types.js";
import { deferred, fakeSession, opened } from "./helpers/session-seam.js";

const PARENT_ID = "parent-1";
const pi = {} as ExtensionAPI;

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "probe",
    description: "probe",
    extensionRules: [],
    toolRules: [],
    discoverSkills: false,
    preloadSkills: [],
    systemPrompt: "Probe.",
    promptMode: "replace",
    ...overrides,
  };
}

describe("AgentManager.restoreEvicted", () => {
  let root: string;
  let sessionsDir: string;
  let ctx: ExtensionContext;
  let manager: AgentManager | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-resume-evicted-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent-dir"));
    sessionsDir = join(root, "agent-dir", "subagent-sessions", PARENT_ID);
    mkdirSync(sessionsDir, { recursive: true });
    registerAgents(new Map([["probe", agentConfig()]]));
    ctx = { cwd: root, sessionManager: { getSessionId: () => PARENT_ID } } as ExtensionContext;
    vi.mocked(openSession).mockReset().mockImplementation(async () => opened(fakeSession(() => "done")));
  });
  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    registerAgents(new Map());
    rmSync(root, { recursive: true, force: true });
  });

  function writeFile(path: string): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "synthetic\n");
    return path;
  }

  function entry(id: string, sessionFile: string, overrides: Partial<EvictedAgent> = {}): EvictedAgent {
    return {
      id,
      type: "probe",
      description: "probe run",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      toolUses: 3,
      lifetimeUsage: { input: 100, output: 20, cacheWrite: 30 },
      sessionFile,
      ...overrides,
    };
  }

  /** A fresh manager whose index knows only `indexed`. */
  function managerWith(indexed: EvictedAgent | undefined): AgentManager {
    manager = new AgentManager();
    manager.setEvictedIndex((id) => (id === indexed?.id ? indexed : undefined));
    return manager;
  }

  /** Spawn and finish a run, then evict it the given way; returns its index entry. */
  async function evicted(eviction: "retention cleanup" | "clearCompleted"): Promise<{ manager: AgentManager; run: EvictedAgent }> {
    if (eviction === "retention cleanup") vi.useFakeTimers();
    const live = new AgentManager();
    manager = live;
    const id = live.spawn(pi, ctx, "probe", "first", { description: "probe run", isBackground: true });
    const record = live.getRecord(id)!;
    await record.promise;
    const run = entry(id, writeFile(join(sessionsDir, "child.jsonl")), { startedAt: record.startedAt, completedAt: record.completedAt });
    if (eviction === "retention cleanup") await vi.advanceTimersByTimeAsync(15 * 60_000 + 60_000);
    else live.clearCompleted();
    if (live.getRecord(id)) throw new Error(`${eviction} did not evict ${id}`);
    live.setEvictedIndex((lookup) => (lookup === id ? run : undefined));
    return { manager: live, run };
  }

  it.each(["retention cleanup", "clearCompleted"] as const)("S4 restoring a run evicted by %s reopens its file under the same id and type", async (eviction) => {
    const { manager, run } = await evicted(eviction);

    await manager.restoreEvicted(pi, ctx, run.id, "again");

    expect(vi.mocked(openSession).mock.lastCall).toEqual([ctx, "probe", expect.objectContaining({
      agentId: run.id,
      resumeSessionFile: realpathSync(run.sessionFile),
      cwd: undefined,
      configCwd: root,
    })]);
    expect(manager.getRecord(run.id)?.session?.prompt).toHaveBeenCalledWith("again");
  });

  it.each(["retention cleanup", "clearCompleted"] as const)("S4 a run evicted by %s is live again with its lifetime accounting seeded", async (eviction) => {
    const { manager, run } = await evicted(eviction);

    const record = await manager.restoreEvicted(pi, ctx, run.id, "again", { isBackground: true });
    await record.promise;

    expect(manager.getRecord(run.id)).toMatchObject({
      id: run.id, status: "completed", resultConsumed: false, toolUses: 3,
      lifetimeUsage: { input: 100, output: 20, cacheWrite: 30 },
    });
  });

  it("S4 a background restore returns at once and joins the background pool", async () => {
    const manager = managerWith(entry("evicted-1", writeFile(join(sessionsDir, "child.jsonl"))));
    manager.setMaxConcurrent(1);
    const gate = deferred<string>();
    vi.mocked(openSession).mockResolvedValueOnce(opened(fakeSession(() => gate.promise)));
    manager.spawn(pi, ctx, "probe", "occupy", { description: "occupant", isBackground: true });

    try {
      const record = await manager.restoreEvicted(pi, ctx, "evicted-1", "again", { isBackground: true });

      expect(record.status).toBe("queued");
    } finally { gate.resolve("done");
      await manager.getRecord("evicted-1")?.promise; }
  });

  it("S4 a foreground restore bypasses the foreground pool", async () => {
    const manager = managerWith(entry("evicted-1", writeFile(join(sessionsDir, "child.jsonl"))));
    manager.setMaxConcurrentForeground(1);
    const gate = deferred<string>();
    vi.mocked(openSession).mockResolvedValueOnce(opened(fakeSession(() => gate.promise)));
    const occupant = manager.spawnAndWait(pi, ctx, "probe", "occupy", { description: "occupant" });

    try {
      const record = await manager.restoreEvicted(pi, ctx, "evicted-1", "again");

      expect(record.status).toBe("completed");
    } finally { gate.resolve("done"); await occupant; }
  });

  it("S5 an empty manager restores a run known only from the history index", async () => {
    const run = entry("evicted-1", writeFile(join(sessionsDir, "child.jsonl")));
    const manager = managerWith(run);

    await manager.restoreEvicted(pi, ctx, run.id, "again");

    expect(openSession).toHaveBeenCalledWith(ctx, "probe", expect.objectContaining({
      agentId: run.id, resumeSessionFile: realpathSync(run.sessionFile),
    }));
    expect(manager.getRecord(run.id)?.session?.prompt).toHaveBeenCalledWith("again");
  });

  it.each([
    ["delegation policy denies the recorded type", () => ({ policy: "Denied by policy." }), /Denied by policy/],
    ["the recorded type is no longer configured", () => ({ type: "ghost" }), /type "ghost" is unavailable/],
    ["the recorded type is disabled", () => ({ disabled: true }), /type "probe" is unavailable/],
    ["the session file is missing", () => ({ missing: true }), /session file is missing/],
  ] as const)("S8 refuses without a record or a runner call when %s", async (_case, setup, error) => {
    const options: { policy?: string; type?: string; disabled?: boolean; missing?: boolean } = setup();
    if (options.disabled) registerAgents(new Map([["probe", agentConfig({ enabled: false })]]));
    const file = options.missing ? join(sessionsDir, "gone.jsonl") : writeFile(join(sessionsDir, "child.jsonl"));
    const manager = managerWith(entry("evicted-1", file, options.type ? { type: options.type } : {}));
    if (options.policy) manager.setPolicyChecker(() => options.policy);

    await expect(manager.restoreEvicted(pi, ctx, "evicted-1", "again")).rejects.toThrow(error);

    expect({ agents: manager.listAgents(), runs: vi.mocked(openSession).mock.calls.length }).toEqual({ agents: [], runs: 0 });
  });

  it("S8 refuses an id with no history entry", async () => {
    const manager = managerWith(undefined);

    await expect(manager.restoreEvicted(pi, ctx, "unknown-1", "again")).rejects.toThrow(/Agent not found: "unknown-1"/);
  });

  it("S8 refuses an id that is still live, leaving the live record alone", async () => {
    manager = new AgentManager();
    const id = manager.spawn(pi, ctx, "probe", "first", { description: "probe run", isBackground: true });
    await manager.getRecord(id)!.promise;
    manager.setEvictedIndex(() => entry(id, writeFile(join(sessionsDir, "child.jsonl"))));

    await expect(manager.restoreEvicted(pi, ctx, id, "again")).rejects.toThrow(/still live/);

    expect({ agents: manager.listAgents().map((record) => record.id), runs: vi.mocked(openSession).mock.calls.length }).toEqual({ agents: [id], runs: 1 });
  });

  it("S9 refuses a pointer outside the owned session directories", async () => {
    const manager = managerWith(entry("evicted-1", writeFile(join(root, "elsewhere", "child.jsonl"))));

    await expect(manager.restoreEvicted(pi, ctx, "evicted-1", "again")).rejects.toThrow(/outside this session's subagent session directories/);
  });

  it("S9 refuses a symlink in the owned directory that escapes it", async () => {
    const outside = writeFile(join(root, "elsewhere", "child.jsonl"));
    const link = join(sessionsDir, "link.jsonl");
    symlinkSync(outside, link);
    const manager = managerWith(entry("evicted-1", link));

    await expect(manager.restoreEvicted(pi, ctx, "evicted-1", "again")).rejects.toThrow(/outside this session's subagent session directories/);
  });

  it("S9 accepts a pointer inside the type's session_dir", async () => {
    registerAgents(new Map([["probe", agentConfig({ sessionDir: "custom-sessions" })]]));
    const file = writeFile(join(root, "custom-sessions", "child.jsonl"));
    const manager = managerWith(entry("evicted-1", file));

    await manager.restoreEvicted(pi, ctx, "evicted-1", "again");

    expect(openSession).toHaveBeenCalledWith(ctx, "probe", expect.objectContaining({ resumeSessionFile: realpathSync(file) }));
    expect(manager.getRecord("evicted-1")?.session?.prompt).toHaveBeenCalledWith("again");
  });

  it("S13 the runner reopens the file only after the evicted session's shutdown settles", async () => {
    const order: string[] = [];
    let releaseShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    const session = Object.assign(fakeSession(() => "first"), {
      extensionRunner: { hasHandlers: () => true, emit: () => shutdown.then(() => { order.push("shutdown settled"); }) },
    });
    manager = new AgentManager();
    vi.mocked(openSession).mockResolvedValueOnce(opened(session));
    const id = manager.spawn(pi, ctx, "probe", "first", { description: "probe run", isBackground: true });
    await manager.getRecord(id)!.promise;
    manager.clearCompleted();
    manager.setEvictedIndex(() => entry(id, writeFile(join(sessionsDir, "child.jsonl"))));
    vi.mocked(openSession).mockImplementationOnce(async () => { order.push("runner"); return opened(fakeSession(() => "done")); });

    const record = await manager.restoreEvicted(pi, ctx, id, "again", { isBackground: true });
    await new Promise((resolve) => setImmediate(resolve));
    releaseShutdown();
    await record.promise;

    expect(order).toEqual(["shutdown settled", "runner"]);
  });
});
