import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";

function pandaWarnPayloads(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((args) => args[0] === "[panda-warn]")
    .map((args) => JSON.parse(args[1] as string));
}

describe("TaskStore DAG self-loop rejection", () => {
  let store: TaskStore;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = new TaskStore();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("rejects addBlocks self-loops before persistence", () => {
    store.create("Self", "Desc");

    const { changedFields, warnings } = store.update("1", { addBlocks: ["1"] });

    expect(store.get("1")!.blocks).toEqual([]);
    expect(store.get("1")!.blockedBy).toEqual([]);
    expect(changedFields).not.toContain("blocks");
    expect(warnings).toContain("edge rejected: self-loop #1 -> #1");
    expect(pandaWarnPayloads(warnSpy)).toContainEqual(expect.objectContaining({
      code: "tasks.dag.edge-rejected",
      from: "1",
      to: "1",
      reason: "self-loop",
    }));
  });

  it("rejects addBlockedBy self-loops before persistence", () => {
    store.create("Self", "Desc");

    const { changedFields, warnings } = store.update("1", { addBlockedBy: ["1"] });

    expect(store.get("1")!.blocks).toEqual([]);
    expect(store.get("1")!.blockedBy).toEqual([]);
    expect(changedFields).not.toContain("blockedBy");
    expect(warnings).toContain("edge rejected: self-loop #1 -> #1");
    expect(pandaWarnPayloads(warnSpy)).toContainEqual(expect.objectContaining({
      code: "tasks.dag.edge-rejected",
      from: "1",
      to: "1",
      reason: "self-loop",
    }));
  });
});
