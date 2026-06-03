import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";

function task(id: string, blocks: string[] = [], blockedBy: string[] = []) {
  return {
    id,
    subject: `Task ${id}`,
    description: "Desc",
    status: "pending",
    metadata: {},
    blocks,
    blockedBy,
    createdAt: 1,
    updatedAt: 1,
  };
}

function pandaWarnPayloads(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((args) => args[0] === "[panda-warn]")
    .map((args) => JSON.parse(args[1] as string));
}

describe("TaskStore DAG load-time quarantine", () => {
  let tempDir: string;
  let filePath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-tasks-dag-"));
    filePath = join(tempDir, "state.json");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("drops bad stored edges, preserves good edges, and writes forensic artifact", () => {
    writeFileSync(filePath, JSON.stringify({
      nextId: 5,
      tasks: [
        task("1", ["2", "999"]),
        task("2", ["3", "2"]),
        task("3", ["1"]),
        task("4", [], ["999"]),
      ],
    }), "utf-8");

    const store = new TaskStore(filePath);

    expect(store.list().map((item) => item.id)).toEqual(["1", "2", "3", "4"]);
    expect(store.get("1")!.blocks).toEqual(["2"]);
    expect(store.get("2")!.blockedBy).toEqual(["1"]);
    expect(store.get("2")!.blocks).toEqual(["3"]);
    expect(store.get("3")!.blockedBy).toEqual(["2"]);
    expect(store.get("3")!.blocks).toEqual([]);
    expect(store.get("4")!.blockedBy).toEqual([]);

    const artifactPath = `${filePath}.quarantined-edges.json`;
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
    expect(artifact.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "1", to: "999", reason: "dangling-target", source: "blocks" }),
      expect.objectContaining({ from: "2", to: "2", reason: "self-loop", source: "blocks" }),
      expect.objectContaining({ from: "3", to: "1", reason: "cycle", source: "blocks" }),
      expect.objectContaining({ from: "999", to: "4", reason: "dangling-target", source: "blockedBy" }),
    ]));

    const persisted = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(persisted.tasks.find((item: { id: string }) => item.id === "3").blocks).toEqual([]);

    const warnPayloads = pandaWarnPayloads(warnSpy);
    expect(warnPayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "tasks.dag.edge-quarantine", from: "3", to: "1", reason: "cycle" }),
      expect.objectContaining({ code: "tasks.dag.edge-quarantine", from: "1", to: "999", reason: "dangling-target" }),
    ]));
  });
});
