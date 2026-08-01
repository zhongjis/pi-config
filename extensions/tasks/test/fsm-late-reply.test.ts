import { beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

// Drive the production entry without installing the real file sink so [panda-warn]
// output stays observable on the console.warn spy (and avoids writing to the real agent dir).
vi.mock("../../lib/warn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/warn.js")>()),
  installPandaWarnFileSink: vi.fn(),
}));

beforeEach(() => { process.env.PI_TASKS = "off"; });

type MockEventBus = {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

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


async function callUpdateRpc(pi: { events: MockEventBus }, params: Record<string, unknown>) {
  const requestId = "late-reply-test";
  return new Promise<any>((resolve) => {
    const unsubscribe = pi.events.on(`tasks:rpc:update:reply:${requestId}`, (reply: unknown) => {
      unsubscribe();
      resolve(reply);
    });
    pi.events.emit("tasks:rpc:update", { requestId, ...params });
  });
}

describe("tasks:rpc:update late reply guard", () => {
  it("drops RPC status regression after internal completion cleanup", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("Task", {
      op: "create",
      tasks: [{ subject: "Completed task", description: "Desc" }],
    });
    await mock.executeTool("Task", { op: "update", tasks: [{ taskId: "1", status: "completed" }] });

    const reply = await callUpdateRpc(mock.pi, { taskId: "1", status: "pending" });

    expect(reply.success).toBe(true);
    expect(reply.data.changedFields).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[panda-warn]",
      expect.stringContaining("tasks.fsm.late-reply-dropped"),
    );

    const result = await mock.executeTool("Task", { op: "get", taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");

    warnSpy.mockRestore();
  });
});
