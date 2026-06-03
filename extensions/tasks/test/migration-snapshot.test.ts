import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/migrations/v1-to-v2.js";

/**
 * Task 26 (Phase 4): the v1 -> v2 migrator must snapshot the existing task
 * directory to `<snapshotRoot>/tasks.bak-pre-v2-<ts>/` BEFORE stamping the v2
 * version field — but only on the FIRST upgrade. Once the state is v2, no new
 * snapshot may be created, and snapshot directories are never auto-deleted.
 */

function listSnapshots(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith("tasks.bak-pre-v2-"));
}

describe("migrate() pre-v2 snapshot", () => {
  let root: string;
  let tasksDir: string;
  let stateFile: string;

  beforeEach(() => {
    // root simulates ~/.pi ; tasksDir simulates ~/.pi/tasks
    root = mkdtempSync(join(tmpdir(), "pi-tasks-mig-"));
    tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    stateFile = join(tasksDir, "state.json");
  });

  afterEach(() => {
    // Best-effort whole-tempdir cleanup; the migrator itself never deletes snapshots.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates a snapshot dir on first v1 -> v2 upgrade and stamps the version", () => {
    const v1 = { nextId: 2, tasks: [{ id: "1", subject: "a", description: "", status: "pending" }] };
    writeFileSync(stateFile, JSON.stringify(v1), "utf-8");
    // A second file in the task dir to prove the whole directory is snapshotted.
    writeFileSync(join(tasksDir, "tasks-config.json"), JSON.stringify({ taskScope: "project" }), "utf-8");

    const result = migrate(v1, { stateFilePath: stateFile, snapshotRoot: root }) as Record<string, unknown>;

    expect(result.schemaVersion).toBe(2);

    const snapshots = listSnapshots(root);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toMatch(/^tasks\.bak-pre-v2-/);

    // Snapshot directory must contain the backed-up files.
    const snapContents = readdirSync(join(root, snapshots[0]));
    expect(snapContents).toContain("state.json");
    expect(snapContents).toContain("tasks-config.json");
  });

  it("does NOT create a new snapshot on a subsequent run (state already v2)", () => {
    const v1 = { nextId: 1, tasks: [] };
    writeFileSync(stateFile, JSON.stringify(v1), "utf-8");

    // First run upgrades and snapshots.
    const upgraded = migrate(v1, { stateFilePath: stateFile, snapshotRoot: root });
    expect(listSnapshots(root).length).toBe(1);

    // Simulate the store persisting the v2 version to disk.
    writeFileSync(stateFile, JSON.stringify(upgraded), "utf-8");

    // Subsequent run on the already-v2 state must not snapshot again.
    const second = migrate(upgraded, { stateFilePath: stateFile, snapshotRoot: root });
    expect(second).toBe(upgraded);
    expect(listSnapshots(root).length).toBe(1);

    // A third run is still a no-op (idempotent, no extra snapshot).
    migrate(second, { stateFilePath: stateFile, snapshotRoot: root });
    expect(listSnapshots(root).length).toBe(1);
  });

  it("fresh-init (no state file) stamps v2 with NO snapshot", () => {
    // No state.json written: this is a fresh install.
    const fresh = { nextId: 1, tasks: [] };
    const result = migrate(fresh, { stateFilePath: stateFile, snapshotRoot: root }) as Record<string, unknown>;

    expect(result.schemaVersion).toBe(2);
    expect(listSnapshots(root).length).toBe(0);
  });

  it("never deletes an existing snapshot directory", () => {
    const v1 = { nextId: 1, tasks: [] };
    writeFileSync(stateFile, JSON.stringify(v1), "utf-8");

    const first = migrate(v1, { stateFilePath: stateFile, snapshotRoot: root });
    const before = listSnapshots(root);
    expect(before.length).toBe(1);

    // Re-running on a fresh v1 state in the same ms would collide with the
    // existing snapshot name; the migrator must skip (never overwrite/delete).
    migrate({ nextId: 1, tasks: [] }, { stateFilePath: stateFile, snapshotRoot: root });
    const after = listSnapshots(root);
    expect(after.length).toBeGreaterThanOrEqual(1);
    // The original snapshot is still present.
    expect(after).toContain(before[0]);
    expect((first as Record<string, unknown>).schemaVersion).toBe(2);
  });
});
