/**
 * graph-persist.ts — durable graph-run snapshots across process restarts.
 *
 * Atomic checkpoints in `.pi/graph-runs/` retain effective topology, runtime
 * identities, scheduler state and bounded-feedback transitions across restarts.
 * Legacy gate snapshots upgrade before dispatch; failed recovery preserves the
 * last complete checkpoint for inspection or another restore.
 *
 * File IO lives here so the runtime (run-graph.ts) stays filesystem-free.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type CheckpointLease, ownCheckpoint, writeOwnedCheckpoint } from "./graph-checkpoint-owner.js";
import { validateCheckpointTransition } from "./graph-checkpoint-transition.js";
import { validateGraphRestore } from "./graph-restore-validation.js";
import { isWorkflowRunId, snapshotDirectory, snapshotPath } from "./graph-snapshot-path.js";
import { validateSchedulerState } from "./graph-state-validation.js";
import type { AgentGraph } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";

export interface GraphRunSnapshot {
  version: 1 | 2;
  runId: string;
  name?: string;
  graph: AgentGraph;
  input: unknown;
  /** Legacy gate identifier. V2 uses scheduler state and leaves this empty. */
  waitingGate: string;
  state: SchedulerState;
  savedAt: number;
}

/** Stable, cross-session directory for durable graph-run snapshots. */
export function graphRunsDir(cwd: string): string {
  return join(cwd, ".pi", "graph-runs");
}

export function writeGraphSnapshot(cwd: string, snapshot: GraphRunSnapshot): void {
  if (snapshot.version !== 1 && snapshot.version !== 2) throw new TypeError("Unsupported checkpoint version");
  if (snapshot.version === 1) validateSchedulerState(snapshot.state, snapshot.graph);
  if (snapshot.version === 2) {
    validateGraphRestore(snapshot.state, snapshot.graph, snapshot.input);
    if (snapshot.state.runtime?.runId !== snapshot.runId) throw new TypeError("Checkpoint run identity mismatch");
  }
  const path = snapshotPath(cwd, snapshot.runId, true);
  const data = JSON.stringify(snapshot);
  const persisted: unknown = JSON.parse(data);
  if (!isSnapshot(persisted)) throw new TypeError("Invalid serialized checkpoint");
  const replacement = (prior: unknown): void => {
    if (!isSnapshot(prior)) throw new TypeError("Invalid previous checkpoint");
    if (prior.version === 1) validateSchedulerState(prior.state, prior.graph);
    if (prior.version === 2) validateGraphRestore(prior.state, prior.graph, prior.input);
    validateCheckpointTransition(prior, persisted);
  };
  if (snapshot.version === 2) {
    if (!snapshot.state.runtime) throw new TypeError("Missing v2 runtime manifest");
    writeOwnedCheckpoint(path, snapshot.state.runtime.revision, data, replacement);
  } else writeOwnedCheckpoint(path, undefined, data, replacement);
}

export function deleteGraphSnapshot(cwd: string, runId: string): void {
  const path = snapshotPath(cwd, runId);
  try {
    rmSync(path, { force: true });
  } catch { // no-excuse-ok: catch — stale cleanup is best effort; reload revalidates it.
    // A snapshot that cannot be deleted is stale, not fatal — it is re-validated
    // and re-deleted on the next reload.
  }
}

/** Read every well-formed snapshot in the runs directory, skipping corrupt files. */
export function readGraphSnapshots(cwd: string, onInvalid: (message: string) => void = console.warn): GraphRunSnapshot[] {
  let dir: string;
  try { dir = snapshotDirectory(cwd); }
  catch { onInvalid("Unsafe graph checkpoint directory"); return []; }
  if (!existsSync(dir)) return [];
  const snapshots: GraphRunSnapshot[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const stem = entry.slice(0, -5);
      const parsed: unknown = JSON.parse(readFileSync(snapshotPath(cwd, stem), "utf-8"));
      if (isSnapshot(parsed) && parsed.runId === stem) {
        if (parsed.version === 1) validateSchedulerState(parsed.state, parsed.graph);
        if (parsed.version === 2) {
          if (!parsed.state.runtime) throw new TypeError("Missing v2 manifest");
          validateGraphRestore(parsed.state, parsed.graph, parsed.input);
          if (parsed.state.runtime.runId !== parsed.runId) throw new TypeError("Checkpoint run identity mismatch");
        }
        snapshots.push(parsed);
      } else onInvalid(`Unsupported or corrupt graph checkpoint: ${JSON.stringify(entry)}`);
    } catch {
      // Preserve invalid files for diagnosis, never dispatch their contents.
      onInvalid(`Unreadable graph checkpoint: ${JSON.stringify(entry)}`);
    }
  }
  return snapshots;
}

function isSnapshot(value: unknown): value is GraphRunSnapshot {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    (s.version === 1 || s.version === 2) &&
    isWorkflowRunId(s.runId) &&
    typeof s.waitingGate === "string" &&
    typeof s.graph === "object" &&
    s.graph !== null &&
    typeof s.state === "object" &&
    s.state !== null
  );
}

export function ownGraphRun(cwd: string, runId: string): CheckpointLease {
  return ownCheckpoint(snapshotPath(cwd, runId, true));
}
