import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockEventBus = {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

function mockPi() {
  const tools = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand() {},
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const handlers = eventHandlers.get(channel);
          if (handlers) eventHandlers.set(channel, handlers.filter(h => h !== handler));
        };
      },
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx().ctx);
    },
    async fireLifecycle(event: string, ...args: any[]) {
      for (const h of lifecycleHandlers.get(event) ?? []) {
        await h(...args);
      }
    },
  };
}

function mockCtx(sessionId = "session-1") {
  const state = {
    widgets: new Map<string, { content: any; options?: any }>(),
    statuses: new Map<string, string | undefined>(),
  };
  const ui = {
    setWidget: vi.fn((key: string, content: any, options?: any) => {
      state.widgets.set(key, { content, options });
    }),
    setStatus: vi.fn((key: string, text: string | undefined) => {
      state.statuses.set(key, text);
    }),
    notify: vi.fn(),
  };

  return {
    ctx: {
      model: { id: "test-model", name: "Test" },
      modelRegistry: {},
      sessionManager: { getSessionId: () => sessionId },
      ui,
    },
    state,
  };
}

function installPingMock(pi: { events: MockEventBus }) {
  return pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });
}

async function callClearCompletedRpc(pi: { events: MockEventBus }) {
  const requestId = `req-${Math.random().toString(36).slice(2)}`;
  return new Promise<any>((resolve) => {
    const unsub = pi.events.on(`tasks:rpc:clear-completed:reply:${requestId}`, (reply: unknown) => {
      unsub();
      resolve(reply);
    });
    pi.events.emit("tasks:rpc:clear-completed", {
      requestId,
      source: "plan-execute-handoff",
    });
  });
}

async function initFreshExtension(mock: ReturnType<typeof mockPi>) {
  vi.resetModules();
  const { default: initExtension } = await import("../src/index.js");
  initExtension(mock.pi as any);
}

describe("tasks:rpc:clear-completed", () => {
  const originalCwd = process.cwd();
  const originalPiTasks = process.env.PI_TASKS;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-tasks-handoff-"));
    process.chdir(tempDir);
    delete process.env.PI_TASKS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPiTasks === undefined) delete process.env.PI_TASKS;
    else process.env.PI_TASKS = originalPiTasks;
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("clears completed tasks only and preserves pending/in_progress tasks", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    installPingMock(mock.pi);
    const session = mockCtx();

    await initFreshExtension(mock);
    await mock.fireLifecycle("before_agent_start", {}, session.ctx);

    await mock.executeTool("TaskCreate", { subject: "Pending", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "Working", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "Done", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "2", status: "in_progress" });
    await mock.executeTool("TaskUpdate", { taskId: "3", status: "completed" });

    const reply = await callClearCompletedRpc(mock.pi);

    expect(reply).toEqual({ success: true, data: { status: "cleared", cleared: 1 } });
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("Status: pending");
    expect((await mock.executeTool("TaskGet", { taskId: "2" })).content[0].text).toContain("Status: in_progress");
    expect((await mock.executeTool("TaskGet", { taskId: "3" })).content[0].text).toBe("Task not found");
  });

  it("returns already_clean when no completed tasks exist", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    installPingMock(mock.pi);

    await initFreshExtension(mock);
    await mock.executeTool("TaskCreate", { subject: "Pending", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "Working", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "2", status: "in_progress" });

    const reply = await callClearCompletedRpc(mock.pi);

    expect(reply).toEqual({ success: true, data: { status: "already_clean", cleared: 0 } });
    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("#1 [pending] Pending");
    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("#2 [in_progress] Working");
  });

  it("skips cleanup for project-scoped stores", async () => {
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    writeFileSync(join(tempDir, ".pi", "tasks-config.json"), JSON.stringify({ taskScope: "project" }, null, 2), { encoding: "utf-8", flag: "w" });

    const mock = mockPi();
    installPingMock(mock.pi);

    await initFreshExtension(mock);
    await mock.executeTool("TaskCreate", { subject: "Done", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const reply = await callClearCompletedRpc(mock.pi);

    expect(reply).toEqual({ success: true, data: { status: "skipped", reason: "shared_store" } });
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("Status: completed");
  });

  it("skips cleanup for explicit PI_TASKS shared-store overrides", async () => {
    process.env.PI_TASKS = join(tempDir, "shared-tasks.json");
    const mock = mockPi();
    installPingMock(mock.pi);

    await initFreshExtension(mock);
    await mock.executeTool("TaskCreate", { subject: "Done", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const reply = await callClearCompletedRpc(mock.pi);

    expect(reply).toEqual({ success: true, data: { status: "skipped", reason: "shared_store" } });
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("Status: completed");
  });

  it("treats PI_TASKS=off as safe to clean", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    installPingMock(mock.pi);

    await initFreshExtension(mock);
    await mock.executeTool("TaskCreate", { subject: "Done", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const reply = await callClearCompletedRpc(mock.pi);

    expect(reply).toEqual({ success: true, data: { status: "cleared", cleared: 1 } });
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("updates the widget and store when the last completed task is cleared", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    installPingMock(mock.pi);
    const session = mockCtx();

    await initFreshExtension(mock);
    await mock.fireLifecycle("before_agent_start", {}, session.ctx);
    await mock.executeTool("TaskCreate", { subject: "Done", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    expect(typeof session.state.widgets.get("tasks")?.content).toBe("function");

    const reply = await callClearCompletedRpc(mock.pi);

    expect(reply).toEqual({ success: true, data: { status: "cleared", cleared: 1 } });
    expect(session.state.widgets.get("tasks")?.content).toBeUndefined();
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("returns an error reply envelope when cleanup throws", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    installPingMock(mock.pi);

    await initFreshExtension(mock);
    const { TaskStore } = await import("../src/task-store.js");
    await mock.executeTool("TaskCreate", { subject: "Done", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    vi.spyOn(TaskStore.prototype, "clearCompleted").mockImplementation(() => {
      throw new Error("cleanup failed");
    });

    const reply = await callClearCompletedRpc(mock.pi);

    expect(reply).toEqual({ success: false, error: "cleanup failed" });
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("Status: completed");
  });

  it("deletes the empty session task file when the last completed task is removed", async () => {
    const mock = mockPi();
    installPingMock(mock.pi);
    const sessionId = "session-file-test";
    const session = mockCtx(sessionId);

    await initFreshExtension(mock);
    await mock.fireLifecycle("before_agent_start", {}, session.ctx);
    await mock.executeTool("TaskCreate", { subject: "Done", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const taskFile = join(tempDir, ".pi", "tasks", `tasks-${sessionId}.json`);
    expect(existsSync(taskFile)).toBe(true);

    const reply = await callClearCompletedRpc(mock.pi);

    expect(reply).toEqual({ success: true, data: { status: "cleared", cleared: 1 } });
    expect(existsSync(taskFile)).toBe(false);
  });
});
