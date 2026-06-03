import { beforeEach, describe, expect, it } from "vitest";
import { ILLEGAL_TRANSITION_CODE } from "../src/fsm.js";
import initExtension from "../src/index.js";

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

describe("TaskUpdate FSM gate", () => {
  it("rejects completed to in_progress for agent-supplied updates", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Done task", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    await expect(mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" }))
      .rejects.toThrow(ILLEGAL_TRANSITION_CODE);

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");
  });

  it("rejects in_progress to pending for agent-supplied updates", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Active task", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    await expect(mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" }))
      .rejects.toThrow(ILLEGAL_TRANSITION_CODE);

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: in_progress");
  });
});
