/**
 * execution-entry-points.test.ts — characterization of every Execution entry
 * point (fresh spawn, evicted resume, live resume) through the real manager,
 * runner, and turn watch. Only session construction is faked, so assertions
 * observe manager records, callbacks, and the fake session.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession, sessionManagerOpen, paths } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  sessionManagerOpen: vi.fn(),
  paths: { freshFile: "" },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession,
  // Runs the runner's extension override over an empty discovery, so extension rules still resolve.
  DefaultResourceLoader: class {
    private readonly override?: (base: { extensions: []; errors: []; runtime: object }) => unknown;
    constructor(options: { extensionsOverride?: (base: { extensions: []; errors: []; runtime: object }) => unknown }) {
      this.override = options.extensionsOverride;
    }
    async reload() { this.override?.({ extensions: [], errors: [], runtime: {} }); }
  },
  SessionManager: {
    create: () => ({
      appendCustomEntry: vi.fn(),
      getSessionId: () => "fresh-child",
      isPersisted: () => true,
      getSessionFile: () => paths.freshFile,
    }),
    open: sessionManagerOpen,
  },
  SettingsManager: { create: () => ({ getSessionDir: () => undefined }) },
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

import { parseAccessRules, resolveExtensionAccess, resolveToolAccess } from "../../lib/active-tools.js";
import { AgentManager } from "../src/agent-manager.js";
import { createAgentResultBuilder } from "../src/agent-result.js";
import { SUBAGENT_LAUNCH_ENTRY } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { failExecutionStart, startExecution } from "../src/execution.js";
import { DELEGATE_RESEARCH_TOOL_NAME } from "../src/research-delegation.js";
import { createResultTools } from "../src/result-tools.js";
import { sessionFastPolicies } from "../src/session-fast.js";
import type { AgentConfig, AgentInvocation, AgentRecord } from "../src/types.js";

const PARENT_ID = "parent-1";
const pi = {} as ExtensionAPI;

/** What a prompt script may drive on the session it runs in. */
interface ScriptedSession {
  model: { provider: string; id: string };
  thinkingLevel: string;
  emit(event: object): void;
}

/** Prompt scripts keyed by prompt text; a script runs before the fake session answers. */
const scripts = new Map<string, (session: ScriptedSession) => Promise<unknown>>();
/** createSession-shaped fake (agent-runner.test.ts): answers `<prompt> answer` after the prompt's script. */
function fakeSession(sessionManager: unknown, extra: object = {}) {
  const listeners: Array<(event: object) => void> = [];
  const session = {
    model: { provider: "fixture", id: "first" },
    thinkingLevel: "low",
    messages: [] as object[],
    sessionManager,
    subscribe: vi.fn((listener: (event: object) => void) => {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    }),
    emit(event: object) { for (const listener of [...listeners]) listener(event); },
    prompt: vi.fn(async (text: string): Promise<void> => {
      await scripts.get(text)?.(session);
      session.messages.push({ role: "assistant", content: [{ type: "text", text: `${text} answer` }], stopReason: "stop" });
    }),
    waitForIdle: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    steer: vi.fn(async (_message: string) => {}),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async (_bindings: { onError?: (error: { extensionPath: string }) => void }) => {}),
    getAllTools: vi.fn(() => []),
    getActiveToolNames: vi.fn(() => []),
    setActiveToolsByName: vi.fn(),
    agent: {},
    dispose: vi.fn(),
    ...extra,
  };
  return session;
}
type FakeSession = ReturnType<typeof fakeSession>;

/** Every session the fake SDK created, in creation order. */
const sessions: FakeSession[] = [];

/** The fake `createAgentSession` result for this session manager. */
function openSession(sessionManager: unknown, extra: object = {}) {
  const session = fakeSession(sessionManager, extra);
  sessions.push(session);
  return { session };
}

const unfinishedTurn = {
  type: "turn_end",
  message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
  toolResults: [],
};

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open: () => open() };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing value");
  return value;
}

const agent = (name: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name,
  description: name,
  extensionRules: [],
  toolRules: parseAccessRules("tools", "+read").rules,
  discoverSkills: false,
  preloadSkills: [],
  systemPrompt: "",
  promptMode: "replace",
  ...overrides,
});

const SCOPED = agent("scoped", {
  extensionRules: parseAccessRules("extensions", "+missing").rules,
  toolRules: parseAccessRules("tools", "+read, +@nope").rules,
});

let root: string;
let sessionsDir: string;
let ctx: ExtensionContext;
let manager: AgentManager;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "execution-entry-points-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent-dir"));
  sessionsDir = join(root, "agent-dir", "subagent-sessions", PARENT_ID);
  mkdirSync(sessionsDir, { recursive: true });
  paths.freshFile = join(sessionsDir, "fresh.jsonl");
  const context: Pick<ExtensionContext, "cwd" | "getSystemPrompt"> & { sessionManager: object; modelRegistry: object } = {
    cwd: root,
    getSystemPrompt: () => "parent prompt",
    sessionManager: { getSessionId: () => PARENT_ID, getBranch: () => [] },
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  };
  ctx = context as ExtensionContext;
  registerAgents(new Map([
    ["probe", agent("probe")],
    ["nester", agent("nester", { allowNesting: true, allowDelegationTo: ["probe"] })],
    ["scoped", SCOPED],
  ]));
  scripts.clear();
  sessions.length = 0;
  createAgentSession.mockReset().mockImplementation(async (options: { sessionManager: unknown }) => openSession(options.sessionManager));
  sessionManagerOpen.mockReset();
});

afterEach(async () => {
  await manager?.dispose();
  vi.unstubAllEnvs();
  registerAgents(new Map());
  rmSync(root, { recursive: true, force: true });
});

/** Index one evicted run whose session file reopens in `cwd`. */
function indexEvicted({ id = "evicted-1", type = "probe", cwd = root }: { id?: string; type?: string; cwd?: string } = {}) {
  const file = join(sessionsDir, `${id}.jsonl`);
  writeFileSync(file, "synthetic\n");
  sessionManagerOpen.mockReturnValueOnce({
    getCwd: () => cwd,
    getHeader: () => ({ type: "session", id: "evicted-child", cwd }),
    buildSessionContext: () => ({ messages: [{ role: "user", content: "earlier" }] }),
    getEntries: () => [{ type: "custom", customType: SUBAGENT_LAUNCH_ENTRY, data: { version: 1, agentId: id, type } }],
    getSessionId: () => "evicted-child",
    getBranch: () => [],
    appendCustomEntry: vi.fn(),
    isPersisted: () => true,
    getSessionFile: () => file,
  });
  manager.setEvictedIndex((lookup) => lookup === id ? {
    id, type, description: "evicted run", status: "completed", startedAt: 1, completedAt: 2,
    toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, sessionFile: file,
  } : undefined);
  return { id, file };
}

/** Park the next session open until the returned gate opens. */
function parkSessionOpen(failure?: Error) {
  const opening = gate();
  createAgentSession.mockImplementationOnce(async (options: { sessionManager: unknown }) => {
    await opening.opened;
    if (failure) throw failure;
    return openSession(options.sessionManager);
  });
  return opening;
}

/** Run `prompt` until the returned gate opens. */
function parkPrompt(prompt: string, before?: (session: ScriptedSession) => void) {
  const running = gate();
  scripts.set(prompt, async (session) => { before?.(session); await running.opened; });
  return running;
}

/** A mid-Execution model fallback: new model and thinking, Fast on. */
function fallBack(session: ScriptedSession, live: AgentSession | undefined) {
  session.model = { provider: "fixture", id: "fallback" };
  session.thinkingLevel = "high";
  // The fallback's `apply` flips the runner-owned policy in place.
  const policy = live ? sessionFastPolicies.get(live) : undefined;
  if (policy) Object.assign(policy, { enabled: true });
}

describe("fresh spawn", () => {
  it("keeps a session opened during a stop attached, unprompted, resumable, and disposed later", async () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete, 4, onStart);
    const sessionListener = vi.fn();
    manager.setSessionListener(sessionListener);
    const opening = parkSessionOpen();
    const id = manager.spawn(pi, ctx, "probe", "go", { description: "probe", isBackground: true });
    const record = required(manager.getRecord(id));
    try {
      expect(record.status).toBe("running");
      expect(onStart).toHaveBeenCalledExactlyOnceWith(record);
      expect(manager.steer(id, "discard on stop")).toEqual({ status: "pending" });
      expect(manager.abort(id, "user")).toBe(true);
      expect(record.pendingSteers).toBeUndefined();
      expect(manager.steer(id, "after stop")).toEqual({ status: "refused" });
      expect(record).toMatchObject({ status: "stopped", interruptionCause: "user" });
      expect(record.session).toBeUndefined();
      expect(manager.hasPendingExecution(id)).toBe(true);
      expect(manager.hasRunning()).toBe(true);
    } finally { opening.open(); }
    const stoppedAt = record.completedAt;
    await record.promise;

    const late = required(sessions[0]);
    expect(record).toMatchObject({ status: "stopped", interruptionCause: "user", result: "", completedAt: stoppedAt, session: late, sessionFile: paths.freshFile });
    expect(late.prompt).not.toHaveBeenCalled();
    expect(late.steer).not.toHaveBeenCalled();
    expect(sessionListener).toHaveBeenCalledExactlyOnceWith(record);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(record);
    expect(manager.hasPendingExecution(id)).toBe(false);
    expect(late.dispose).not.toHaveBeenCalled();

    await manager.resume(id, "again");
    expect(record).toMatchObject({ status: "completed", result: "again answer", session: late });
    expect(late.prompt).toHaveBeenCalledExactlyOnceWith("again");

    manager.clearCompleted();
    expect(late.dispose).toHaveBeenCalledOnce();
  });

  it("flushes steers sent before the session opened to it before the prompt", async () => {
    manager = new AgentManager();
    const opening = parkSessionOpen();
    const id = manager.spawn(pi, ctx, "probe", "go", { description: "probe", isBackground: true });
    const record = required(manager.getRecord(id));
    try {
      expect(manager.steer(id, "first")).toEqual({ status: "pending" });
      expect(manager.steer(id, "second")).toEqual({ status: "pending" });
    } finally { opening.open(); }
    await record.promise;

    const session = required(sessions[0]);
    expect(session.steer.mock.calls).toEqual([["first"], ["second"]]);
    expect(Math.max(...session.steer.mock.invocationCallOrder)).toBeLessThan(required(session.prompt.mock.invocationCallOrder[0]));
    expect(record.pendingSteers).toBeUndefined();
    expect(record.status).toBe("completed");
  });

  it("records a setup failure after a stop as the error of a stopped run", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const opening = parkSessionOpen(new Error("session open failed"));
    const id = manager.spawn(pi, ctx, "probe", "go", { description: "probe", isBackground: true });
    const record = required(manager.getRecord(id));
    try {
      manager.abort(id, "user");
    } finally { opening.open(); }
    const stoppedAt = record.completedAt;
    await record.promise;

    expect(record).toMatchObject({ status: "stopped", interruptionCause: "user", error: "session open failed", completedAt: stoppedAt });
    expect(record.session).toBeUndefined();
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(record);
  });

  it("fails a queued start whose cwd vanished without a start event or a session, and keeps draining", async () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete, 1, onStart);
    const holding = parkPrompt("hold");
    const cwd = mkdtempSync(join(root, "vanishing-"));
    const blocker = manager.spawn(pi, ctx, "probe", "hold", { description: "blocker", isBackground: true });
    const failing = manager.spawn(pi, ctx, "probe", "fail", { description: "failing", isBackground: true, cwd });
    const next = manager.spawn(pi, ctx, "probe", "next", { description: "next", isBackground: true });
    rmSync(cwd, { recursive: true });
    try {
      expect(manager.getRecord(failing)?.status).toBe("queued");
    } finally { holding.open(); }
    await manager.waitForAll();

    const failed = required(manager.getRecord(failing));
    expect(failed).toMatchObject({ status: "error", error: expect.stringContaining(cwd) });
    expect(failed.completedAt).toBeDefined();
    expect(failed.activity).toBeUndefined();
    expect(onStart.mock.calls.map(([record]) => record.id)).toEqual([blocker, next]);
    expect(onComplete.mock.calls.map(([record]) => record.id)).toEqual([blocker, failing, next]);
    expect(manager.getRecord(next)?.status).toBe("completed");
    expect(createAgentSession).toHaveBeenCalledTimes(2);
  });

  it("labels the record from the session at attach and again after a model fallback", async () => {
    manager = new AgentManager();
    let id = "";
    let beforeAttach: AgentInvocation | undefined;
    let atAttach: AgentInvocation | undefined;
    createAgentSession.mockImplementationOnce(async (options: { sessionManager: unknown }) => {
      beforeAttach = { ...manager.getRecord(id)?.invocation };
      return openSession(options.sessionManager);
    });
    scripts.set("go", async (session) => {
      session.model = { provider: "fixture", id: "fallback" };
      session.thinkingLevel = "high";
      const live = manager.getRecord(id)?.session;
      // The fallback's `apply` flips the runner-owned policy in place.
      const policy = live ? sessionFastPolicies.get(live) : undefined;
      if (policy) Object.assign(policy, { enabled: true });
    });

    const { record } = await manager.spawnAndWait(pi, ctx, "probe", "go", {
      description: "probe",
      onSessionCreated: () => { atAttach = { ...manager.getRecord(id)?.invocation }; },
    }, (spawned) => { id = spawned; });

    expect(beforeAttach).toMatchObject({ modelName: undefined, thinking: undefined, fast: undefined });
    expect(atAttach).toMatchObject({ modelName: "fixture/first", thinking: "low", fast: false });
    expect(record.invocation).toMatchObject({ modelName: "fixture/fallback", thinking: "high", fast: true });
  });
});

describe("setup diagnostics", () => {
  it.each(["fresh spawn", "evicted resume"] as const)("reach the record on a %s", async (entry) => {
    manager = new AgentManager();
    createAgentSession.mockImplementationOnce(async (options: { sessionManager: unknown }) => {
      const { session } = openSession(options.sessionManager);
      session.bindExtensions.mockImplementation(async ({ onError }) => { onError?.({ extensionPath: "/ext/broken.ts" }); });
      return { session };
    });
    let record: AgentRecord;
    if (entry === "fresh spawn") {
      ({ record } = await manager.spawnAndWait(pi, ctx, "scoped", "go", { description: "scoped" }));
    } else {
      const { id } = indexEvicted({ type: "scoped" });
      record = await manager.restoreEvicted(pi, ctx, id, "go");
    }

    const [extensionWarning] = resolveExtensionAccess(SCOPED.extensionRules, []).diagnostics;
    const [toolWarning] = resolveToolAccess(SCOPED.toolRules, []).diagnostics;
    expect(record.status).toBe("completed");
    expect(record.diagnostics).toEqual([
      expect.stringContaining(required(extensionWarning).message),
      expect.stringContaining("/ext/broken.ts"),
      expect.stringContaining(required(toolWarning).message),
    ]);
  });
});

describe("evicted resume", () => {
  it("settles a stop during the disposal wait as stopped, reopened but unprompted, retaining ownership until then", async () => {
    const onStart = vi.fn();
    manager = new AgentManager(undefined, 1, onStart);
    const shutdown = gate();
    createAgentSession.mockImplementationOnce(async (options: { sessionManager: unknown }) =>
      openSession(options.sessionManager, { extensionRunner: { hasHandlers: () => true, emit: () => shutdown.opened } }));
    const { id } = await manager.spawnAndWait(pi, ctx, "probe", "first", { description: "probe" });
    manager.clearCompleted();
    indexEvicted({ id });
    const record = await manager.restoreEvicted(pi, ctx, id, "again", { isBackground: true });
    try {
      expect(record.status).toBe("running");
      expect(onStart).toHaveBeenLastCalledWith(record);
      const queued = manager.spawn(pi, ctx, "probe", "next", { description: "next", isBackground: true });
      expect(manager.getRecord(queued)?.status).toBe("queued");
      expect(manager.abort(id, "user")).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sessionManagerOpen).not.toHaveBeenCalled();
      expect(record.status).toBe("stopped");
      expect(manager.hasPendingExecution(id)).toBe(true);
    } finally { shutdown.open(); }
    const stoppedAt = record.completedAt;
    await record.promise;

    const reopened = required(sessions[1]);
    expect(sessionManagerOpen).toHaveBeenCalledOnce();
    expect(record).toMatchObject({ status: "stopped", interruptionCause: "user", completedAt: stoppedAt, session: reopened });
    expect(reopened.prompt).not.toHaveBeenCalled();
    expect(manager.hasPendingExecution(id)).toBe(false);
    await manager.waitForAll();
  });

  it("settles a reopen refused after admission as an error of the admitted record", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const sessionListener = vi.fn();
    manager.setSessionListener(sessionListener);
    const missing = join(root, "missing-cwd");
    const { id } = indexEvicted({ cwd: missing });

    const record = await manager.restoreEvicted(pi, ctx, id, "again");

    expect(record).toMatchObject({ status: "error", error: expect.stringContaining(missing) });
    expect(record.completedAt).toBeDefined();
    expect(record.session).toBeUndefined();
    expect(manager.getRecord(id)).toBe(record);
    expect(manager.hasPendingExecution(id)).toBe(false);
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(sessionListener).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(record);
  });

  it("gives the reopened session delegate_research for an allow_nesting type", async () => {
    manager = new AgentManager();
    const { id } = indexEvicted({ type: "nester" });

    const record = await manager.restoreEvicted(pi, ctx, id, "again");

    expect(record.status).toBe("completed");
    expect(sessionManagerOpen).toHaveBeenCalledOnce();
    expect(createAgentSession.mock.lastCall?.[0].tools).toContain(DELEGATE_RESEARCH_TOOL_NAME);
  });
});

describe("live resume", () => {
  it("clears the prior Execution's outcome at admission, structured output at start, and keeps the session", async () => {
    manager = new AgentManager(undefined, 1);
    const { id, record } = await manager.spawnAndWait(pi, ctx, "probe", "first", { description: "probe" });
    const session = required(sessions[0]);
    Object.assign(record, { error: "prior failure", interruptionCause: "user", convertedAtCheckIn: true, structuredJson: "{}", structuredRetried: true });
    const priorExecution = record.executionId;
    const holding = parkPrompt("hold");
    const resuming = parkPrompt("again");
    const busy = required(manager.getRecord(manager.spawn(pi, ctx, "probe", "hold", { description: "busy", isBackground: true })));
    try {
      await manager.resume(id, "again", undefined, undefined, { isBackground: true });
      expect(record).toMatchObject({
        status: "queued", isBackground: true, resultConsumed: false, invocation: { runInBackground: true },
        session, structuredJson: "{}", structuredRetried: true,
      });
      expect(record.executionId).not.toBe(priorExecution);
      for (const field of ["result", "error", "interruptionCause", "convertedAtCheckIn"] as const) expect(record[field]).toBeUndefined();

      expect(manager.steer(id, "queued resume")).toEqual({ status: "pending" });
      expect(session.steer).not.toHaveBeenCalled();
      holding.open();
      await busy.promise;
      expect(session.steer).toHaveBeenCalledExactlyOnceWith("queued resume");
      expect(record.pendingSteers).toBeUndefined();
      expect(record.status).toBe("running");
      for (const field of ["structuredJson", "structuredRetried", "completedAt"] as const) expect(record[field]).toBeUndefined();
      expect(record.session).toBe(session);
    } finally { holding.open(); resuming.open(); }
    await record.promise;

    expect(record).toMatchObject({ status: "completed", result: "again answer", session });
  });

  it("keeps the stop time as completedAt when a stopped resume settles", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      manager = new AgentManager();
      const { id, record } = await manager.spawnAndWait(pi, ctx, "probe", "first", { description: "probe" });
      const resuming = parkPrompt("again");
      try {
        await manager.resume(id, "again", undefined, undefined, { isBackground: true });
        vi.setSystemTime(2_000);
        expect(manager.abort(id, "user")).toBe(true);
        vi.setSystemTime(3_000);
      } finally { resuming.open(); }
      await record.promise;

      expect(record).toMatchObject({ status: "stopped", interruptionCause: "user", completedAt: 2_000 });
    } finally { vi.useRealTimers(); }
  });

  it("labels the record from the session at start and again at Settlement after a model fallback", async () => {
    manager = new AgentManager();
    const { id, record } = await manager.spawnAndWait(pi, ctx, "probe", "first", { description: "probe" });
    required(sessions[0]).model = { provider: "fixture", id: "second" };
    let atStart: AgentInvocation | undefined;
    scripts.set("again", async (session) => {
      atStart = { ...record.invocation };
      fallBack(session, record.session);
    });

    await manager.resume(id, "again");

    expect(atStart).toMatchObject({ modelName: "fixture/second", thinking: "low", fast: false });
    expect(record).toMatchObject({ status: "completed", invocation: { modelName: "fixture/fallback", thinking: "high", fast: true } });
  });
});

describe("steering ownership", () => {
  it("buffers in onStart before a live resume attaches its retained session", async () => {
    const atStart: string[] = [];
    manager = new AgentManager(undefined, 4, record => {
      if (record.session) {
        atStart.push(manager.steer(record.id, "before attach").status);
        expect(required(sessions[0]).steer).not.toHaveBeenCalled();
      }
    });
    const { id } = await manager.spawnAndWait(pi, ctx, "probe", "first", { description: "probe" });
    await manager.resume(id, "again");
    expect(atStart).toEqual(["pending"]);
    expect(required(sessions[0]).steer).toHaveBeenCalledExactlyOnceWith("before attach");
  });

  it("clears pending steering at Settlement and at start failure", async () => {
    manager = new AgentManager();
    const { record } = await manager.spawnAndWait(pi, ctx, "probe", "first", { description: "probe" });
    const execution = startExecution(record);
    const holding = parkPrompt("again");
    const running = execution.run(required(record.session), "again");
    record.pendingSteers = ["discard at settlement"];
    holding.open();
    await running;
    expect(record.pendingSteers).toBeUndefined();
    record.pendingSteers = ["discard at start failure"];
    failExecutionStart(record, new Error("start failed"));
    expect(record.pendingSteers).toBeUndefined();
  });

  it("clears buffered steering when opening fails and diagnoses buffered delivery rejection", async () => {
    manager = new AgentManager();
    const opening = parkSessionOpen(new Error("open failed"));
    const id = manager.spawn(pi, ctx, "probe", "go", { description: "probe", isBackground: true });
    const record = required(manager.getRecord(id));
    manager.steer(id, "queued");
    opening.open();
    await record.promise;
    expect(record.pendingSteers).toBeUndefined();
    expect(record.error).toBe("open failed");

    const nextOpening = gate();
    createAgentSession.mockImplementationOnce(async (options: { sessionManager: unknown }) => {
      await nextOpening.opened;
      const opened = openSession(options.sessionManager);
      opened.session.steer.mockRejectedValueOnce(new Error("steer failed"));
      return opened;
    });
    const next = manager.spawn(pi, ctx, "probe", "next", { description: "probe", isBackground: true });
    manager.steer(next, "queued failure");
    nextOpening.open();
    const nextRecord = required(manager.getRecord(next));
    await nextRecord.promise;
    expect(nextRecord.pendingSteers).toBeUndefined();
    expect(nextRecord.diagnostics).toContain("Failed to steer agent: steer failed");
  });
});

describe("settlement label", () => {
  it.each(["fresh spawn", "live resume"] as const)("comes from the session when a %s throws after attach", async (entry) => {
    manager = new AgentManager();
    let id = "";
    if (entry === "live resume") {
      ({ id } = await manager.spawnAndWait(pi, ctx, "probe", "first", { description: "probe" }));
      required(sessions[0]).waitForIdle.mockRejectedValue(new Error("drain failed"));
    } else {
      createAgentSession.mockImplementationOnce(async (options: { sessionManager: unknown }) => {
        const opened = openSession(options.sessionManager);
        opened.session.waitForIdle.mockRejectedValue(new Error("drain failed"));
        return opened;
      });
    }
    scripts.set("go", async (session) => { fallBack(session, manager.getRecord(id)?.session); });

    if (entry === "fresh spawn") await manager.spawnAndWait(pi, ctx, "probe", "go", { description: "probe" }, (spawned) => { id = spawned; });
    else await manager.resume(id, "go");

    expect(manager.getRecord(id)).toMatchObject({
      status: "error", error: "drain failed",
      invocation: { modelName: "fixture/fallback", thinking: "high", fast: true },
    });
  });
});

describe("orchestrator check-in", () => {
  it.each(["fresh spawn", "live resume"] as const)("wakes a waiter registered while the %s was queued once it starts", async (entry) => {
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "1");
    manager = new AgentManager(undefined, 1);
    const listener = vi.fn();
    manager.setCheckInListener(listener);
    let id = "";
    if (entry === "live resume") ({ id } = await manager.spawnAndWait(pi, ctx, "probe", "first", { description: "probe" }));
    const holding = parkPrompt("hold");
    const working = parkPrompt("work", (session) => session.emit(unfinishedTurn));
    const busy = required(manager.getRecord(manager.spawn(pi, ctx, "probe", "hold", { description: "busy", isBackground: true })));
    try {
      if (entry === "fresh spawn") id = manager.spawn(pi, ctx, "probe", "work", { description: "probe", isBackground: true });
      else await manager.resume(id, "work", undefined, undefined, { isBackground: true });
      expect(manager.getRecord(id)?.status).toBe("queued");
      const woken = manager.waitForSettlementOrCheckIn(id);
      const buildDetails = createAgentResultBuilder(() => false);
      const cancelNudge = vi.fn();
      const tools = createResultTools(pi, manager, {
        cancelNudge,
        details: record => buildDetails({ displayName: "probe", description: "probe", subagentType: "probe" }, record),
      }, { retrieve: vi.fn() });
      let retrieved: Awaited<ReturnType<typeof tools.getAgentResult.execute>> | undefined;
      const retrieval = tools.getAgentResult.execute("get", { run_id: id, wait: true }, undefined, undefined, ctx)
        .then(result => { retrieved = result; return result; });
      try {
        holding.open();
        await busy.promise;
        await expect(woken).resolves.toBe(1);
        // Let tool-result promise continuations run without advancing timer tasks.
        for (let tick = 0; tick < 10; tick++) await Promise.resolve();
        expect(retrieved?.details).toMatchObject({ status: "running" });
        expect(manager.getRecord(id)).toMatchObject({ status: "running", resultConsumed: false });
        expect(manager.hasPendingExecution(id)).toBe(true);
        expect(cancelNudge).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
      } finally { working.open(); await retrieval; }
    } finally { holding.open(); working.open(); }
    await manager.waitForAll();
  });

  it.each(["fresh spawn", "live resume"] as const)("does not check in once a %s is stopped", async (entry) => {
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "1");
    manager = new AgentManager();
    const listener = vi.fn();
    manager.setCheckInListener(listener);
    const working = gate();
    scripts.set("work", async (session) => { await working.opened; session.emit(unfinishedTurn); });
    let id = "";
    try {
      if (entry === "fresh spawn") id = manager.spawn(pi, ctx, "probe", "work", { description: "probe", isBackground: true });
      else {
        ({ id } = await manager.spawnAndWait(pi, ctx, "probe", "first", { description: "probe" }));
        await manager.resume(id, "work", undefined, undefined, { isBackground: true });
      }
      await vi.waitFor(() => expect(sessions[0]?.prompt).toHaveBeenCalledWith("work"));
      const waiting = manager.waitForSettlementOrCheckIn(id);
      manager.abort(id, "user");
      working.open();

      await expect(waiting).resolves.toBeUndefined();
      expect(manager.getRecord(id)).toMatchObject({ status: "stopped", turnCount: 1 });
      expect(listener).not.toHaveBeenCalled();
    } finally { working.open(); }
  });
});
