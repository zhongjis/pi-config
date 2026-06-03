// Phase 1.3 red→green; do not skip
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../../src/task-store.js";

/**
 * Regression for Phase 1.3 (Task 9):
 * TaskStore.load() runs on every locked mutation. A malformed state.json
 * must NOT throw — it must quarantine the corrupt file and start fresh,
 * emitting a single pandaWarnOnce notification across repeated loads.
 *
 * This test is intentionally RED on current HEAD. Do not weaken assertions
 * to make it pass — Task 9 must implement the recovery path.
 */

function makeTempStorePath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-tasks-corrupt-"));
  return { dir, file: join(dir, "state.json") };
}

function listCorruptSiblings(dir: string, baseName: string): string[] {
  return readdirSync(dir).filter(
    (name) => name.startsWith(`${baseName}.corrupt-`),
  );
}

function pandaWarnCalls(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter(
    (args) => typeof args[0] === "string" && args[0] === "[panda-warn]",
  );
}

describe("TaskStore corrupt state.json recovery (regression)", () => {
  let tempDir: string;
  let filePath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const tmp = makeTempStorePath();
    tempDir = tmp.dir;
    filePath = tmp.file;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    // Intentionally do NOT auto-delete .corrupt-<ts> files — Task 8 spec
    // requires verifying they exist post-test. Best-effort cleanup of the
    // whole temp dir only.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("malformed JSON: load does not throw and returns a valid empty store", () => {
    writeFileSync(filePath, "{not valid json at all", "utf-8");

    let store: TaskStore | undefined;
    expect(() => {
      store = new TaskStore(filePath);
    }).not.toThrow();

    expect(store).toBeDefined();
    expect(store!.list()).toEqual([]);

    // A fresh-start store must accept new writes immediately.
    const fresh = store!.create("post-recovery", "should be id 1");
    expect(fresh.id).toBe("1");
  });

  it("malformed JSON: original file is quarantined to <name>.corrupt-<ts>", () => {
    writeFileSync(filePath, "}}}garbage{{{", "utf-8");

    // Construct triggers load() via the constructor path.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _store = new TaskStore(filePath);

    const siblings = listCorruptSiblings(tempDir, "state.json");
    expect(siblings.length).toBeGreaterThanOrEqual(1);
    // Quarantine name must include a timestamp suffix.
    expect(siblings[0]).toMatch(/^state\.json\.corrupt-\d+/);
  });

  it("pandaWarnOnce fires exactly once across N consecutive loads of the same corrupt file", () => {
    writeFileSync(filePath, "<<<not-json>>>", "utf-8");

    // Multiple constructions / list() calls each invoke load() internally.
    // Across all of them, the corrupt-detection warning must dedupe to one.
    for (let i = 0; i < 5; i++) {
      const s = new TaskStore(filePath);
      // Force at least one extra load by touching list (file-backed get/list re-load).
      s.list();
      // Re-write the file as corrupt for the next iteration to simulate a
      // persistently-corrupt scenario; quarantine in iteration i may have
      // moved it, so re-seed.
      writeFileSync(filePath, `<<<not-json-${i}>>>`, "utf-8");
    }

    const warnCalls = pandaWarnCalls(warnSpy);
    expect(warnCalls.length).toBe(1);
    // Payload should be parseable JSON describing the corruption event.
    const payload = JSON.parse(warnCalls[0][1] as string);
    expect(payload).toMatchObject({ code: expect.any(String) });
  });
});

describe("TaskStore corrupt state.json fuzz (regression)", () => {
  let tempDir: string;
  let filePath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const tmp = makeTempStorePath();
    tempDir = tmp.dir;
    filePath = tmp.file;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("property: 100 random byte inputs must never make TaskStore.load() throw", () => {
    // Deterministic PRNG so failures are reproducible across runs.
    let seed = 0x9e3779b1;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };

    for (let i = 0; i < 100; i++) {
      const len = rand() % 4096; // 0..4095 bytes
      const bytes = Buffer.alloc(len);
      for (let b = 0; b < len; b++) bytes[b] = rand() & 0xff;
      writeFileSync(filePath, bytes);

      expect(() => {
        const s = new TaskStore(filePath);
        // Touch list() to force any lazy code paths that re-load.
        s.list();
      }, `iteration ${i} (len=${len})`).not.toThrow();

      // Clean any quarantine siblings between iterations so the directory
      // does not grow without bound; the per-iteration assertion above is
      // the property under test.
      for (const sib of listCorruptSiblings(tempDir, "state.json")) {
        try {
          rmSync(join(tempDir, sib));
        } catch {
          /* ignore */
        }
      }
    }
  });
});
