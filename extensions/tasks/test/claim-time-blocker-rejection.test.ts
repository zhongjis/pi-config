import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENTS_READY } from "../../lib/subagent-channels.js";
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

function installSubagentsMock(pi: { events: MockEventBus }) {
  const spawned: string[] = [];

  const unsubscribePing = pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });

  const unsubscribeSpawn = pi.events.on("subagents:rpc:spawn", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    const id = `agent-${spawned.length + 1}`;
    spawned.push(id);
    pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id } });
  });

  pi.events.emit(SUBAGENTS_READY, {});

  return {
    spawned,
    dispose() {
      unsubscribePing();
      unsubscribeSpawn();
    },
  };
}

function parsePandaWarns(warnSpy: ReturnType<typeof vi.spyOn>) {
  return warnSpy.mock.calls
    .filter(call => call[0] === "[panda-warn]")
    .map(call => JSON.parse(String(call[1])));
}

describe("claim-time blocker rejection", () => {
  it("rejects TaskUpdate claim when blocker is pending", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = mockPi();
    const subagents = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Blocker", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "Blocked", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await expect(mock.executeTool("TaskUpdate", { taskId: "2", status: "in_progress" }))
      .rejects.toThrow("tasks.claim.blocker-not-satisfied");
    await expect(mock.executeTool("TaskUpdate", { taskId: "2", owner: "agent-1" }))
      .rejects.toThrow("tasks.claim.blocker-not-satisfied");

    const task = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(task.content[0].text).toContain("Status: pending");

    expect(parsePandaWarns(warnSpy)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "tasks.claim.rejected",
        taskId: "2",
        blockerId: "1",
        reason: "pending",
      }),
    ]));

    subagents.dispose();
    warnSpy.mockRestore();
  });

  it("rejects TaskExecute claim when blocker is pending", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = mockPi();
    const subagents = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Blocker", description: "Desc", agentType: "general-purpose" });
    await mock.executeTool("TaskCreate", { subject: "Blocked", description: "Desc", agentType: "general-purpose" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["2"] });

    expect(result.content[0].text).toContain("tasks.claim.blocker-not-satisfied");
    expect(result.content[0].text).toContain("blocked by #1 (pending)");
    expect(subagents.spawned).toEqual([]);
    expect(parsePandaWarns(warnSpy)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "tasks.claim.rejected",
        taskId: "2",
        blockerId: "1",
        reason: "pending",
      }),
    ]));

    subagents.dispose();
    warnSpy.mockRestore();
  });
});
