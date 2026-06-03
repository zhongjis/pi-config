import { describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrate } from "../src/migrations/v1-to-v2.js";

/**
 * Task 26 (Phase 4): the schema migrator must be idempotent and total.
 *
 * - migrate() on a v2 state is a no-op (same reference back).
 * - migrate() on a v1 state stamps schemaVersion: 2.
 * - migrate(migrate(v1)) on the second pass is a no-op.
 * - migrate() never throws for arbitrary (fuzzed) input.
 *
 * These tests exercise the pure function directly (no opts), so no snapshot
 * filesystem side effects occur — snapshot behavior is covered separately in
 * migration-snapshot.test.ts.
 */

function v1State() {
  return {
    nextId: 3,
    tasks: [
      { id: "1", subject: "a", description: "", status: "pending" },
      { id: "2", subject: "b", description: "", status: "completed" },
    ],
  };
}

describe("migrate() idempotency", () => {
  it("returns a v2 state object unchanged (same reference)", () => {
    const v2 = { schemaVersion: CURRENT_SCHEMA_VERSION, nextId: 1, tasks: [] };
    expect(migrate(v2)).toBe(v2);
    // Calling again is still a no-op on the same reference.
    expect(migrate(migrate(v2))).toBe(v2);
  });

  it("stamps schemaVersion: 2 on a v1 state (missing schemaVersion)", () => {
    const v1 = v1State();
    const result = migrate(v1) as Record<string, unknown>;

    expect(result.schemaVersion).toBe(2);
    // Existing fields are preserved.
    expect(result.nextId).toBe(3);
    expect(Array.isArray(result.tasks)).toBe(true);
    // v1 input itself is not mutated (a new object is returned).
    expect((v1 as Record<string, unknown>).schemaVersion).toBeUndefined();
  });

  it("treats an explicit schemaVersion: 1 as v1 and upgrades it", () => {
    const result = migrate({ schemaVersion: 1, nextId: 1, tasks: [] }) as Record<string, unknown>;
    expect(result.schemaVersion).toBe(2);
  });

  it("is idempotent: migrating the upgraded result again is a no-op", () => {
    const upgraded = migrate(v1State());
    // Second application returns the same (already-v2) reference unchanged.
    expect(migrate(upgraded)).toBe(upgraded);
    expect((upgraded as Record<string, unknown>).schemaVersion).toBe(2);
  });

  it("warns and leaves an unknown future version unchanged (read-only-safe)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const future = { schemaVersion: 99, nextId: 1, tasks: [] };
      expect(migrate(future)).toBe(future);

      const warnCalls = warnSpy.mock.calls.filter((args) => args[0] === "[panda-warn]");
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      const payload = JSON.parse(warnCalls[0][1] as string);
      expect(payload.code).toBe("tasks.migration.unknown-version");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("migrate() fuzz: never throws for arbitrary input", () => {
  it("property: 100 random schemas must never make migrate() throw", () => {
    // Suppress unknown-version warnings produced by random schemaVersion values.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Deterministic PRNG so any failure is reproducible.
      let seed = 0x12345678;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed;
      };

      const sample = (depth: number): unknown => {
        const kind = rand() % 7;
        switch (kind) {
          case 0:
            return rand();
          case 1:
            return `s${rand()}`;
          case 2:
            return rand() % 2 === 0;
          case 3:
            return null;
          case 4:
            return depth > 2 ? rand() : [sample(depth + 1), sample(depth + 1)];
          case 5: {
            const obj: Record<string, unknown> = {
              nextId: rand() % 5,
              tasks: depth > 2 ? [] : [sample(depth + 1)],
            };
            // Randomly attach a schemaVersion of varied type/value.
            const sv = rand() % 5;
            if (sv === 1) obj.schemaVersion = 1;
            else if (sv === 2) obj.schemaVersion = 2;
            else if (sv === 3) obj.schemaVersion = rand();
            else if (sv === 4) obj.schemaVersion = `v${rand()}`;
            return obj;
          }
          default:
            return undefined;
        }
      };

      for (let i = 0; i < 100; i++) {
        // Round-trip through JSON to mirror real parsed on-disk state.
        const raw = sample(0);
        let input: unknown = raw;
        try {
          input = JSON.parse(JSON.stringify(raw));
        } catch {
          input = raw; // undefined / circular-safe fallback
        }
        expect(() => migrate(input), `iteration ${i}`).not.toThrow();
        // The result must still be returnable (no throw on re-migrate either).
        expect(() => migrate(migrate(input)), `iteration ${i} re-migrate`).not.toThrow();
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});
