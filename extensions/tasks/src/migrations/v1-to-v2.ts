/**
 * v1-to-v2.ts — Versioned on-disk schema migrator for the task store.
 *
 * Schema history:
 *   v1 — `{ nextId, tasks }` with NO `schemaVersion` field (legacy on-disk shape).
 *   v2 — `{ schemaVersion: 2, nextId, tasks }` (current).
 *
 * `migrate()` is the single, idempotent entrypoint. It is called from the
 * task-store load path while the advisory file lock is held. It only mutates
 * the in-memory state object it returns — it never rewrites past append-only
 * session log entries and never deletes snapshot directories.
 *
 * Behavior matrix:
 *   - Already v2 (`schemaVersion === 2`): returns the input object unchanged
 *     (same reference) — idempotent no-op.
 *   - v1 (`schemaVersion` missing or `=== 1`): if a real on-disk state file
 *     exists, snapshots the whole task directory to
 *     `<snapshotRoot>/tasks.bak-pre-v2-<ts>/` BEFORE stamping the version,
 *     then returns a new object with `schemaVersion: 2`.
 *   - Fresh-init (no state file on disk): stamps `schemaVersion: 2` with NO
 *     snapshot (nothing to back up).
 *   - Unknown/future version (any other `schemaVersion`): emits a
 *     `tasks.migration.unknown-version` warning and returns the input
 *     unchanged (read-only-safe — never throws, never mutates).
 *
 * The function is intentionally total: it must NEVER throw for any input,
 * including arbitrary/fuzzed data. Snapshotting is best-effort and wrapped so
 * filesystem failures cannot break a load.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pandaWarn } from "../../../lib/warn.js";

/** Current on-disk schema version stamped into `state.json`. */
export const CURRENT_SCHEMA_VERSION = 2;

/** Filesystem context required to snapshot existing v1 state before upgrade. */
export interface MigrateOptions {
  /** Absolute path to the backing `state.json` (used to detect fresh-init and locate the source dir). */
  stateFilePath?: string;
  /** Directory under which the `tasks.bak-pre-v2-<ts>/` snapshot is written. */
  snapshotRoot?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Filesystem-safe ISO timestamp (colons/dots replaced so it is portable across filesystems). */
function snapshotTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Best-effort snapshot of the existing task directory before a v1 -> v2 upgrade.
 * No-op when there is no on-disk state (fresh-init) or when snapshot context is
 * missing. Never throws — snapshot failure must not break a store load.
 */
function backupExistingState(opts: MigrateOptions): void {
  const { stateFilePath, snapshotRoot } = opts;
  if (!stateFilePath || !snapshotRoot) return;
  // Fresh-init: the backing file does not exist yet, so there is nothing to back up.
  if (!existsSync(stateFilePath)) return;
  try {
    const sourceDir = dirname(stateFilePath);
    if (!existsSync(sourceDir)) return;
    const dest = join(snapshotRoot, `tasks.bak-pre-v2-${snapshotTimestamp()}`);
    // Never overwrite an existing snapshot, and never auto-delete snapshots.
    if (existsSync(dest)) return;
    mkdirSync(snapshotRoot, { recursive: true });
    cpSync(sourceDir, dest, { recursive: true });
  } catch {
    /* snapshot is best-effort; migration must never throw */
  }
}

/**
 * Idempotently migrate an on-disk task-store state object to the current schema.
 *
 * @param state Parsed on-disk state (any shape; fuzz-safe — never throws).
 * @param opts  Optional filesystem context enabling the pre-upgrade snapshot.
 * @returns The same reference when already current or unknown; a new object
 *          stamped with `schemaVersion: 2` when upgrading from v1/fresh.
 */
export function migrate<T>(state: T, opts: MigrateOptions = {}): T {
  if (!isRecord(state)) return state;

  const version = state.schemaVersion;

  // Already current — idempotent no-op (preserve reference).
  if (version === CURRENT_SCHEMA_VERSION) return state;

  // v1 (missing or explicit version 1) or fresh-init: snapshot then stamp v2.
  if (version === undefined || version === 1) {
    backupExistingState(opts);
    return { ...state, schemaVersion: CURRENT_SCHEMA_VERSION } as T;
  }

  // Unknown/future version: read-only-safe. Warn and leave the state untouched.
  pandaWarn("tasks.migration.unknown-version", {
    found: typeof version === "number" ? version : String(version),
  });
  return state;
}
