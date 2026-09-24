/**
 * Non-owning child activations share the process registry but not its lifecycle.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workflow = vi.hoisted(() => ({
  active: false,
  parentNotifications: 0,
  stop: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("../src/graph/graph-runtime.js", () => ({
  createGraphRuntime: vi.fn(() => ({
    tool: {},
    loadHistory: vi.fn(),
    getRuns: () => [],
    resume: workflow.resume,
    stop: workflow.stop,
    fleetGraphRuns: () => [],
  })),
}));

import { AgentManager } from "../src/agent-manager.js";
import subagentsExtension from "../src/index.js";
import { AgentWidget } from "../src/ui/agent-widget.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
type LifecycleHandler = (...args: unknown[]) => unknown;

function makePi() {
  const tools = new Map<string, unknown>();
  const lifecycle = new Map<string, LifecycleHandler>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: { name: string }) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: LifecycleHandler) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  return { pi, tools, lifecycle };
}

function context() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "parent"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  };
}

async function fire(host: ReturnType<typeof makePi>, event: string, ...args: unknown[]): Promise<void> {
  const handler = host.lifecycle.get(event);
  expect(handler, `${event} handler is registered`).toBeDefined();
  await handler?.(...args);
}

describe("manager registry lifecycle ownership", () => {
  let tmpDir: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;
  const priorRegistry = Reflect.get(globalThis, MANAGER_KEY);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-lifecycle-owner-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-lifecycle-owner-agentdir-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, agentGraphEnabled: false }));
    process.chdir(tmpDir);
    Reflect.deleteProperty(globalThis, MANAGER_KEY);
    workflow.active = false;
    workflow.parentNotifications = 0;
    workflow.stop.mockImplementation(async () => {
      if (workflow.active) workflow.parentNotifications++;
    });
    workflow.stop.mockClear();
    workflow.resume.mockClear();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (priorRegistry === undefined) Reflect.deleteProperty(globalThis, MANAGER_KEY);
    else Reflect.set(globalThis, MANAGER_KEY, priorRegistry);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("keeps an active parent workflow and manager untouched by child lifecycle events while the owner still cleans up", async () => {
    const clearCompleted = vi.spyOn(AgentManager.prototype, "clearCompleted");
    const abortAll = vi.spyOn(AgentManager.prototype, "abortAll");
    const dispose = vi.spyOn(AgentManager.prototype, "dispose");
    const widgetDispose = vi.spyOn(AgentWidget.prototype, "dispose");
    const parent = makePi();
    Reflect.apply(subagentsExtension, undefined, [parent.pi]);
    await fire(parent, "session_start", {}, context());

    workflow.stop.mockClear();
    clearCompleted.mockClear();
    abortAll.mockClear();
    dispose.mockClear();
    workflow.active = true;

    const child = makePi();
    Reflect.apply(subagentsExtension, undefined, [child.pi]);
    expect(child.tools.has("Agent"), "child tool registration remains available").toBe(true);
    await fire(child, "session_start", {}, context());
    await fire(child, "tool_execution_start", {}, context());
    await fire(child, "session_before_switch");
    await fire(child, "session_shutdown", {}, context());

    expect(workflow.stop, "child cannot stop the active parent workflow").not.toHaveBeenCalled();
    expect(workflow.parentNotifications, "child cannot emit the parent workflow notification").toBe(0);
    expect(clearCompleted, "child cannot clear the parent manager").not.toHaveBeenCalled();
    expect(dispose, "child disposes its local manager").toHaveBeenCalledOnce();
    expect(widgetDispose, "child disposes its local widget").toHaveBeenCalledOnce();
    const childManager = dispose.mock.contexts[0];
    expect(abortAll, "child manager aborts only through its local disposal").toHaveBeenCalledOnce();
    expect(abortAll.mock.contexts[0]).toBe(childManager);
    expect(
      child.pi.events.emit.mock.calls.filter(([event]) => event === "subagents:ready"),
      "child cannot publish lifecycle readiness",
    ).toHaveLength(0);

    await fire(parent, "session_before_switch");
    expect(workflow.stop).toHaveBeenCalledWith("switch");
    expect(clearCompleted).toHaveBeenCalledWith(true);

    await fire(parent, "session_shutdown", { reason: "shutdown" }, context());
    expect(workflow.stop).toHaveBeenCalledWith("shutdown");
    expect(dispose).toHaveBeenCalledTimes(2);
    const parentManager = dispose.mock.contexts[1];
    expect(parentManager).not.toBe(childManager);
    expect(abortAll.mock.contexts.slice(1)).toEqual([parentManager, parentManager]);
  });
});
