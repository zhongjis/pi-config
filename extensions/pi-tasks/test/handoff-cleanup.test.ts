import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockEventBus = {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
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
    async executeCommand(name: string, args = "", ctx?: any) {
      const command = commands.get(name);
      if (!command) throw new Error(`Command ${name} not registered`);
      return command.handler(args, ctx ?? mockCtx().ctx);
    },
    async fireLifecycle(event: string, ...args: any[]) {
      for (const h of lifecycleHandlers.get(event) ?? []) {
        await h(...args);
      }
    },
  };
}

function mockCtx(sessionId = "session-1", entries: any[] = [], uiOverrides: Record<string, any> = {}) {
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
    select: vi.fn(async () => undefined),
    input: vi.fn(async () => undefined),
    ...uiOverrides,
  };

  return {
    ctx: {
      model: { id: "test-model", name: "Test" },
      modelRegistry: {},
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => entries,
      },
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

async function callClearPlanningTasksRpc(pi: { events: MockEventBus }, sessionId: string) {
  const requestId = `req-${Math.random().toString(36).slice(2)}`;
  return new Promise<any>((resolve) => {
    const unsub = pi.events.on(`tasks:rpc:clear-planning-tasks:reply:${requestId}`, (reply: unknown) => {
      unsub();
      resolve(reply);
    });
    pi.events.emit("tasks:rpc:clear-planning-tasks", {
      requestId,
      source: "plan-execute-handoff",
      sessionId,
    });
  });
}

function installSubagentRpcMocks(
  pi: { events: MockEventBus },
  options: { spawnId?: string; onStop?: (agentId: string) => void } = {},
) {
  const spawnId = options.spawnId ?? "agent-123";
  const stopped: string[] = [];

  const unsubscribeSpawn = pi.events.on("subagents:rpc:spawn", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id: spawnId } });
  });

  const unsubscribeStop = pi.events.on("subagents:rpc:stop", (data: unknown) => {
    const { requestId, agentId } = data as { requestId: string; agentId: string };
    stopped.push(agentId);
    options.onStop?.(agentId);
    pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
  });

  return {
    stopped,
    dispose() {
      unsubscribeSpawn();
      unsubscribeStop();
    },
  };
}

async function initFreshExtension(mock: ReturnType<typeof mockPi>) {
  vi.resetModules();
  const { default: initExtension } = await import("../src/index.js");
  initExtension(mock.pi as any);
}

function getTaskMetadata(result: { content: Array<{ text: string }> }) {
  const line = result.content[0]?.text
    .split("\n")
    .find((entry) => entry.startsWith("Metadata: "));
  return line ? JSON.parse(line.slice("Metadata: ".length)) : {};
}

describe("tasks:rpc:clear-planning-tasks", () => {
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

  it("removes only current-session planning tasks and preserves everything else", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    installPingMock(mock.pi);
    const currentPlanningSession = mockCtx("session-1", [
      { type: "custom", customType: "agent-mode", data: { mode: "fuxi" } },
    ]);
    const otherPlanningSession = mockCtx("session-2", [
      { type: "custom", customType: "agent-mode", data: { mode: "fuxi" } },
    ]);
    const normalSession = mockCtx("session-1", [
      { type: "custom", customType: "agent-mode", data: { mode: "kuafu" } },
    ]);

    await initFreshExtension(mock);

    await mock.executeTool("TaskCreate", { subject: "Plan pending", description: "Desc" }, currentPlanningSession.ctx);
    await mock.executeTool("TaskCreate", { subject: "Plan working", description: "Desc" }, currentPlanningSession.ctx);
    await mock.executeTool("TaskCreate", { subject: "Plan done", description: "Desc" }, currentPlanningSession.ctx);
    await mock.executeTool("TaskUpdate", { taskId: "2", status: "in_progress" }, currentPlanningSession.ctx);
    await mock.executeTool("TaskUpdate", { taskId: "3", status: "completed" }, currentPlanningSession.ctx);

    await mock.executeTool("TaskCreate", { subject: "Keep completed", description: "Desc" }, normalSession.ctx);
    await mock.executeTool("TaskUpdate", { taskId: "4", status: "completed" }, normalSession.ctx);

    await mock.executeTool("TaskCreate", { subject: "Other session planning", description: "Desc" }, otherPlanningSession.ctx);

    const reply = await callClearPlanningTasksRpc(mock.pi, "session-1");

    expect(reply).toEqual({
      success: true,
      data: { status: "cleared", removed: 3, removedIncomplete: 2 },
    });
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toBe("Task not found");
    expect((await mock.executeTool("TaskGet", { taskId: "2" })).content[0].text).toBe("Task not found");
    expect((await mock.executeTool("TaskGet", { taskId: "3" })).content[0].text).toBe("Task not found");
    expect((await mock.executeTool("TaskGet", { taskId: "4" })).content[0].text).toContain("Status: completed");
    expect(getTaskMetadata(await mock.executeTool("TaskGet", { taskId: "5" }))).toMatchObject({
      _piWorkflowPhase: "planning",
      _piOriginMode: "fuxi",
      _piOriginSessionId: "session-2",
    });
  });

  it("returns already_clean when the current session has no planning tasks", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    installPingMock(mock.pi);
    const otherPlanningSession = mockCtx("session-2", [
      { type: "custom", customType: "agent-mode", data: { mode: "fuxi" } },
    ]);
    const normalSession = mockCtx("session-1", [
      { type: "custom", customType: "agent-mode", data: { mode: "kuafu" } },
    ]);

    await initFreshExtension(mock);

    await mock.executeTool("TaskCreate", { subject: "Keep normal", description: "Desc" }, normalSession.ctx);
    await mock.executeTool("TaskCreate", { subject: "Keep other planning", description: "Desc" }, otherPlanningSession.ctx);

    const reply = await callClearPlanningTasksRpc(mock.pi, "session-1");

    expect(reply).toEqual({
      success: true,
      data: { status: "already_clean", removed: 0, removedIncomplete: 0 },
    });
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("Status: pending");
    expect(getTaskMetadata(await mock.executeTool("TaskGet", { taskId: "2" }))).toMatchObject({
      _piOriginSessionId: "session-2",
    });
  });

  it("stops active subagent bindings before deleting in-progress planning tasks", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    installPingMock(mock.pi);
    const session = mockCtx("session-stop", [
      { type: "custom", customType: "agent-mode", data: { mode: "fuxi" } },
    ]);
    const order: string[] = [];
    const subagents = installSubagentRpcMocks(mock.pi, {
      spawnId: "agent-stop-1",
      onStop: (agentId) => order.push(`stop:${agentId}`),
    });

    await initFreshExtension(mock);
    await mock.fireLifecycle("before_agent_start", {}, session.ctx);

    await mock.executeTool(
      "TaskCreate",
      {
        subject: "Plan execute",
        description: "Desc",
        agentType: "jintong",
      },
      session.ctx,
    );

    const { TaskStore } = await import("../src/task-store.js");
    const originalDelete = TaskStore.prototype.delete;
    vi.spyOn(TaskStore.prototype, "delete").mockImplementation(function (this: InstanceType<typeof TaskStore>, id: string) {
      order.push(`delete:${id}`);
      return originalDelete.call(this, id);
    });

    const executeResult = await mock.executeTool("TaskExecute", { task_ids: ["1"] }, session.ctx);
    expect(executeResult.content[0].text).toContain("Launched 1 agent(s)");

    const reply = await callClearPlanningTasksRpc(mock.pi, "session-stop");

    expect(reply).toEqual({
      success: true,
      data: { status: "cleared", removed: 1, removedIncomplete: 1 },
    });
    expect(subagents.stopped).toEqual(["agent-stop-1"]);
    expect(order).toEqual(["stop:agent-stop-1", "delete:1"]);
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toBe("Task not found");
    expect(session.state.widgets.get("tasks")?.content).toBeUndefined();

    subagents.dispose();
  });

  it("deletes the empty session task file when the last planning task is removed", async () => {
    const mock = mockPi();
    installPingMock(mock.pi);
    const sessionId = "session-file-test";
    const session = mockCtx(sessionId, [
      { type: "custom", customType: "agent-mode", data: { mode: "fuxi" } },
    ]);

    await initFreshExtension(mock);
    await mock.fireLifecycle("before_agent_start", {}, session.ctx);
    await mock.executeTool("TaskCreate", { subject: "Plan only", description: "Desc" }, session.ctx);

    const taskFile = join(tempDir, ".pi", "tasks", `tasks-${sessionId}.json`);
    expect(existsSync(taskFile)).toBe(true);

    const reply = await callClearPlanningTasksRpc(mock.pi, sessionId);

    expect(reply).toEqual({
      success: true,
      data: { status: "cleared", removed: 1, removedIncomplete: 1 },
    });
    expect(existsSync(taskFile)).toBe(false);
  });
});

describe("Fu Xi planning provenance", () => {
  const originalCwd = process.cwd();
  const originalPiTasks = process.env.PI_TASKS;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-tasks-provenance-"));
    process.chdir(tempDir);
    process.env.PI_TASKS = "off";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPiTasks === undefined) delete process.env.PI_TASKS;
    else process.env.PI_TASKS = originalPiTasks;
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stamps planning provenance on TaskCreate during fuxi mode", async () => {
    const mock = mockPi();
    installPingMock(mock.pi);
    const session = mockCtx("session-fuxi", [
      { type: "custom", customType: "agent-mode", data: { mode: "kuafu" } },
      { type: "custom", customType: "agent-mode", data: { mode: "fuxi" } },
    ]);

    await initFreshExtension(mock);
    await mock.executeTool(
      "TaskCreate",
      {
        subject: "Plan task",
        description: "Desc",
        metadata: { lane: "ux", _piOriginMode: "spoofed" },
      },
      session.ctx,
    );

    const metadata = getTaskMetadata(await mock.executeTool("TaskGet", { taskId: "1" }, session.ctx));
    expect(metadata).toEqual({
      lane: "ux",
      _piWorkflowPhase: "planning",
      _piOriginMode: "fuxi",
      _piOriginSessionId: "session-fuxi",
    });
  });

  it("strips reserved provenance keys from non-fuxi task creation", async () => {
    const mock = mockPi();
    installPingMock(mock.pi);
    const session = mockCtx("session-kuafu", [
      { type: "custom", customType: "agent-mode", data: { mode: "kuafu" } },
    ]);

    await initFreshExtension(mock);
    await mock.executeTool(
      "TaskCreate",
      {
        subject: "Normal task",
        description: "Desc",
        metadata: {
          keep: "yes",
          _piWorkflowPhase: "spoofed",
          _piOriginMode: "spoofed",
          _piOriginSessionId: "spoofed",
        },
      },
      session.ctx,
    );

    const metadata = getTaskMetadata(await mock.executeTool("TaskGet", { taskId: "1" }, session.ctx));
    expect(metadata).toEqual({ keep: "yes" });
  });

  it("ignores reserved provenance keys on TaskUpdate metadata merges", async () => {
    const mock = mockPi();
    installPingMock(mock.pi);
    const session = mockCtx("session-update", [
      { type: "custom", customType: "agent-mode", data: { mode: "fuxi" } },
    ]);

    await initFreshExtension(mock);
    await mock.executeTool("TaskCreate", { subject: "Plan task", description: "Desc" }, session.ctx);
    const result = await mock.executeTool(
      "TaskUpdate",
      {
        taskId: "1",
        metadata: {
          note: "keep",
          _piWorkflowPhase: "done",
          _piOriginMode: "kuafu",
          _piOriginSessionId: null,
        },
      },
      session.ctx,
    );

    expect(result.content[0].text).toContain(
      "warning: reserved metadata keys ignored: _piWorkflowPhase, _piOriginMode, _piOriginSessionId",
    );

    const metadata = getTaskMetadata(await mock.executeTool("TaskGet", { taskId: "1" }, session.ctx));
    expect(metadata).toEqual({
      note: "keep",
      _piWorkflowPhase: "planning",
      _piOriginMode: "fuxi",
      _piOriginSessionId: "session-update",
    });
  });

  it("stamps planning provenance for /tasks createTask during fuxi mode", async () => {
    const mock = mockPi();
    installPingMock(mock.pi);
    const session = mockCtx(
      "session-command",
      [{ type: "custom", customType: "agent-mode", data: { mode: "fuxi" } }],
      {
        select: vi.fn()
          .mockResolvedValueOnce("Create task")
          .mockResolvedValueOnce(undefined),
        input: vi.fn()
          .mockResolvedValueOnce("Plan from menu")
          .mockResolvedValueOnce("Desc"),
      },
    );

    await initFreshExtension(mock);
    await mock.executeCommand("tasks", "", session.ctx);

    const metadata = getTaskMetadata(await mock.executeTool("TaskGet", { taskId: "1" }, session.ctx));
    expect(metadata).toEqual({
      _piWorkflowPhase: "planning",
      _piOriginMode: "fuxi",
      _piOriginSessionId: "session-command",
    });
  });
});
