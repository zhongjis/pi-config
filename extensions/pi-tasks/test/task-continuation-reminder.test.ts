import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initTasksExtension from "../src/index.js";
import initTaskContinuationReminder from "../../task-continuation-reminder.js";

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
        for (const handler of eventHandlers.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const handlers = eventHandlers.get(channel);
          if (handlers) eventHandlers.set(channel, handlers.filter(h => h !== handler));
        };
      },
    } satisfies MockEventBus,
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx());
    },
    async fireLifecycle(event: string, ...args: any[]) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(...args);
      }
    },
  };
}

function mockCtx(overrides: Record<string, any> = {}) {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    sessionManager: {
      getSessionId: () => "session-1",
      getEntries: () => [],
    },
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
    hasPendingMessages: () => false,
    ...overrides,
  };
}

describe("task-continuation-reminder extension", () => {
  let tempDir: string;
  let tasksPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-task-continuation-"));
    tasksPath = join(tempDir, "tasks.json");
    process.env.PI_TASKS = tasksPath;
  });

  afterEach(() => {
    delete process.env.PI_TASKS;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function runAgentTurn(mock: ReturnType<typeof mockPi>, ctx: any, stopReason = "stop") {
    await mock.fireLifecycle("agent_start", {}, ctx);
    await mock.fireLifecycle("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
    await mock.fireLifecycle("turn_end", {
      turnIndex: 1,
      message: { role: "assistant", usage: { input: 1, output: 1 } },
      toolResults: [],
    }, ctx);
    await mock.fireLifecycle("agent_end", { messages: [{ role: "assistant", stopReason }] }, ctx);
  }

  it("sends a visible follow-up continuation reminder when incomplete tasks remain", async () => {
    const mock = mockPi();
    initTasksExtension(mock.pi as any);
    initTaskContinuationReminder(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Pending", description: "desc" });

    const ctx = mockCtx();
    await runAgentTurn(mock, ctx);

    expect(mock.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "task-continuation-reminder",
        content: expect.stringContaining("Incomplete tasks remain in your task list"),
        display: true,
        details: { incompleteTaskIds: ["1"] },
      }),
      expect.objectContaining({ deliverAs: "followUp", triggerTurn: true }),
    );
  });

  it("stops sending reminders after three repeated single-turn follow-ups with unchanged tasks", async () => {
    const mock = mockPi();
    initTasksExtension(mock.pi as any);
    initTaskContinuationReminder(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Pending", description: "desc" });

    const ctx = mockCtx();

    await runAgentTurn(mock, ctx);
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);

    await runAgentTurn(mock, ctx);
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(2);

    await runAgentTurn(mock, ctx);
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(3);

    await runAgentTurn(mock, ctx);
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not send reminders when all tasks are completed", async () => {
    const mock = mockPi();
    initTasksExtension(mock.pi as any);
    initTaskContinuationReminder(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Done", description: "desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const ctx = mockCtx();
    await runAgentTurn(mock, ctx);

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });
});
