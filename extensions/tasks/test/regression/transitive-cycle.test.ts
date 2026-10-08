/**
 * Regression: transitive dependency cycle detection.
 *
 * This test asserts that creating the closing edge of a transitive cycle is
 * rejected (edge NOT persisted).
 *
 * Uses TaskStore directly: this is the same public-path wrapper that
 * task-store.test.ts uses to exercise TaskCreate/TaskUpdate tool surfaces
 * (the tools in src/index.ts are thin adapters over store.create/store.update).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../../src/task-store.js";

describe("TaskStore transitive cycle rejection (regression)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(); // in-memory, fast
  });

  it("rejects insertion that closes a transitive 3-cycle A→B→C→A", () => {
    // TaskCreate path: build three tasks.
    const a = store.create("A", "node A");
    const b = store.create("B", "node B");
    const c = store.create("C", "node C");
    expect([a.id, b.id, c.id]).toEqual(["1", "2", "3"]);

    // TaskUpdate.addBlocks path: build chain A→B→C with no cycle.
    const r1 = store.update(a.id, { addBlocks: [b.id] });
    expect(r1.warnings).toEqual([]);
    const r2 = store.update(b.id, { addBlocks: [c.id] });
    expect(r2.warnings).toEqual([]);

    // Closing edge C→A creates transitive cycle A→B→C→A.
    // Expected: rejected — edge not added AND warning surfaced.
    const r3 = store.update(c.id, { addBlocks: [a.id] });

    // Primary assertion: closing edge must NOT be persisted.
    expect(store.get(c.id)!.blocks).not.toContain(a.id);
    expect(store.get(a.id)!.blockedBy).not.toContain(c.id);

    // Secondary assertion: a cycle warning must mention transitive/cycle.
    expect(r3.warnings.some(w => /cycle/i.test(w))).toBe(true);
  });
});
