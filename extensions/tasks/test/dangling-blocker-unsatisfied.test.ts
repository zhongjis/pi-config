import { beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";

// Drive the production entry without installing the real file sink so [panda-warn]
// output stays observable on the console.warn spy (and avoids writing to the real agent dir).
vi.mock("../../lib/warn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/warn.js")>()),
  installPandaWarnFileSink: vi.fn(),
}));

beforeEach(() => { process.env.PI_TASKS = "off"; });


function mockCtx() {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    sessionManager: {
      getSessionId: () => "session-1",
      getEntries: () => [],
    },
    ui: {
      setWidget() {},
      setStatus() {},
      notify() {},
    },
  };
}

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
          if (handlers) eventHandlers.set(channel, handlers.filter(item => item !== handler));
        };
      },
    },
  };

  return {
    pi,
    async executeTool(name: string, params: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, mockCtx());
    },
  };
}


function parsePandaWarns(warnSpy: ReturnType<typeof vi.spyOn>) {
  return warnSpy.mock.calls
    .filter((call: unknown[]) => call[0] === "[panda-warn]")
    .map((call: unknown[]) => JSON.parse(String(call[1])));
}

function captureCreatedTasks() {
  const tasks: Task[] = [];
  const originalCreate = TaskStore.prototype.create;
  const createSpy = vi.spyOn(TaskStore.prototype, "create").mockImplementation(function (
    this: TaskStore,
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, any>,
  ) {
    const task = originalCreate.call(this, subject, description, activeForm, metadata);
    tasks.push(task);
    return task;
  });
  return { tasks, createSpy };
}

describe("dangling blocker claim semantics", () => {
  it("rejects TaskUpdate claim when blocker ID is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tasks, createSpy } = captureCreatedTasks();
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("Task", { op: "create", tasks: [{ subject: "Blocked", description: "Desc" }] });
    tasks[0].blockedBy.push("999");

    const rejected = await mock.executeTool("Task", { op: "update", tasks: [{ taskId: "1", status: "in_progress" }] });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("tasks.claim.blocker-not-satisfied");

    const task = await mock.executeTool("Task", { op: "get", taskId: "1" });
    expect(task.content[0].text).toContain("Status: pending");
    expect(parsePandaWarns(warnSpy)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "tasks.claim.rejected",
        taskId: "1",
        blockerId: "999",
        reason: "dangling",
      }),
    ]));

    createSpy.mockRestore();
    warnSpy.mockRestore();
  });

});
