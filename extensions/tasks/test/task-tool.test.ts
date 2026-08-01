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
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand() {},
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit() {},
      on() { return () => {}; },
    },
  };

  return {
    pi,
    tools,
    async executeTool(name: string, params: any, ctx: any = mockCtx()) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx);
    },
  };
}

function text(result: any): string {
  return result.content[0].text;
}

describe("Task consolidated tool", () => {
  it("registers a single Task tool (no legacy names)", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    expect([...mock.tools.keys()].sort()).toEqual(["Task"]);
  });

  it("S1: batch create returns deterministic IDs and list shows them", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    const created = await mock.executeTool("Task", {
      op: "create",
      tasks: [
        { subject: "Alpha", description: "A" },
        { subject: "Bravo", description: "B" },
        { subject: "Charlie", description: "C" },
      ],
    });
    expect(text(created)).toContain("Created 3 tasks: #1, #2, #3");
    expect(text(created)).toContain("#2: Bravo");

    const listed = await mock.executeTool("Task", { op: "list" });
    expect(text(listed)).toContain("#1 [pending] Alpha");
    expect(text(listed)).toContain("#3 [pending] Charlie");
  });

  it("S1b: single get returns full detail", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("Task", { op: "create", tasks: [{ subject: "Solo", description: "desc-solo" }] });

    const got = await mock.executeTool("Task", { op: "get", taskId: "1" });
    expect(text(got)).toContain("Task #1: Solo");
    expect(text(got)).toContain("Status: pending");
    expect(text(got)).toContain("desc-solo");
  });

  it("S2: batch update applies mixed statuses in one call", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("Task", {
      op: "create",
      tasks: [{ subject: "One", description: "1" }, { subject: "Two", description: "2" }],
    });

    const updated = await mock.executeTool("Task", {
      op: "update",
      tasks: [
        { taskId: "1", status: "completed" },
        { taskId: "2", status: "in_progress" },
      ],
    });
    expect(updated.isError).toBeFalsy();
    expect(text(updated)).toContain("Updated 2 tasks");
    expect(text(updated)).toContain("#1");
    expect(text(updated)).toContain("#2");

    expect(text(await mock.executeTool("Task", { op: "get", taskId: "1" }))).toContain("Status: completed");
    expect(text(await mock.executeTool("Task", { op: "get", taskId: "2" }))).toContain("Status: in_progress");
  });

  it("S3: batch update is best-effort — illegal transition rejected, valid applied, tree intact", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("Task", {
      op: "create",
      tasks: [{ subject: "Done", description: "1" }, { subject: "Fresh", description: "2" }],
    });
    // Put #1 into completed so completed->in_progress is illegal.
    await mock.executeTool("Task", { op: "update", tasks: [{ taskId: "1", status: "completed" }] });

    const mixed = await mock.executeTool("Task", {
      op: "update",
      tasks: [
        { taskId: "1", status: "in_progress" }, // illegal
        { taskId: "2", status: "in_progress" }, // valid
      ],
    });
    expect(text(mixed)).toContain("Updated 1 task");
    expect(text(mixed)).toContain("Rejected 1 task");
    expect(text(mixed)).toContain(ILLEGAL_TRANSITION_CODE);
    expect(mixed.isError).toBeFalsy(); // partial success is not a hard error

    // #1 unchanged (still completed), #2 advanced
    expect(text(await mock.executeTool("Task", { op: "get", taskId: "1" }))).toContain("Status: completed");
    expect(text(await mock.executeTool("Task", { op: "get", taskId: "2" }))).toContain("Status: in_progress");
  });

  it("S3b: update where every item is rejected returns isError", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("Task", { op: "create", tasks: [{ subject: "Done", description: "1" }] });
    await mock.executeTool("Task", { op: "update", tasks: [{ taskId: "1", status: "completed" }] });

    const rejected = await mock.executeTool("Task", {
      op: "update",
      tasks: [{ taskId: "1", status: "in_progress" }],
    });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toContain(ILLEGAL_TRANSITION_CODE);
    expect(text(await mock.executeTool("Task", { op: "get", taskId: "1" }))).toContain("Status: completed");
  });

  it("supports DAG wiring via two-step create then update addBlockedBy", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("Task", {
      op: "create",
      tasks: [{ subject: "Blocker", description: "b" }, { subject: "Blocked", description: "b2" }],
    });
    await mock.executeTool("Task", { op: "update", tasks: [{ taskId: "2", addBlockedBy: ["1"] }] });

    const got = text(await mock.executeTool("Task", { op: "get", taskId: "2" }));
    expect(got).toContain("Blocked by: #1");
  });

  it("rejects malformed calls (shape errors) hard", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await expect(mock.executeTool("Task", { op: "create", tasks: [{ subject: "NoDesc" } as any] }))
      .rejects.toThrow();
    await expect(mock.executeTool("Task", { op: "update", tasks: [{ status: "completed" } as any] }))
      .rejects.toThrow();
    await expect(mock.executeTool("Task", { op: "get" } as any))
      .rejects.toThrow();
    await expect(mock.executeTool("Task", { op: "bogus" } as any))
      .rejects.toThrow();
  });

  it("list reports empty state", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    expect(text(await mock.executeTool("Task", { op: "list" }))).toBe("No tasks found");
  });
});
