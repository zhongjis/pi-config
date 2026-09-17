/**
 * graph-persist.ts — durable graph-run snapshots across process restarts.
 *
 * A graph run that pauses at a human_gate writes a snapshot to a stable,
 * cross-session directory (`.pi/graph-runs/`), so a restart can reload the
 * waiting run, restore its progress, and re-surface the gate (design §1.3). The
 * snapshot holds everything a resume needs: the graph, its input, the settled
 * node state, and which gate was waiting. It is deleted when the run settles.
 *
 * File IO lives here so the runtime (run-graph.ts) stays filesystem-free.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentGraph } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";

export interface GraphRunSnapshot {
  version: 1;
  runId: string;
  name?: string;
  graph: AgentGraph;
  input: unknown;
  /** The human_gate node id that was awaiting when this was written. */
  waitingGate: string;
  state: SchedulerState;
  savedAt: number;
}

/** Stable, cross-session directory for durable graph-run snapshots. */
export function graphRunsDir(cwd: string): string {
  return join(cwd, ".pi", "graph-runs");
}

export function writeGraphSnapshot(cwd: string, snapshot: GraphRunSnapshot): void {
  const dir = graphRunsDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${snapshot.runId}.json`), JSON.stringify(snapshot), "utf-8");
}

export function deleteGraphSnapshot(cwd: string, runId: string): void {
  try {
    rmSync(join(graphRunsDir(cwd), `${runId}.json`), { force: true });
  } catch {
    // A snapshot that cannot be deleted is stale, not fatal — it is re-validated
    // and re-deleted on the next reload.
  }
}

/** Read every well-formed snapshot in the runs directory, skipping corrupt files. */
export function readGraphSnapshots(cwd: string): GraphRunSnapshot[] {
  const dir = graphRunsDir(cwd);
  if (!existsSync(dir)) return [];
  const snapshots: GraphRunSnapshot[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), "utf-8")) as unknown;
      if (isSnapshot(parsed)) snapshots.push(parsed);
    } catch {
      // Skip a half-written or hand-corrupted snapshot rather than fail startup.
    }
  }
  return snapshots;
}

function isSnapshot(value: unknown): value is GraphRunSnapshot {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    s.version === 1 &&
    typeof s.runId === "string" &&
    typeof s.waitingGate === "string" &&
    typeof s.graph === "object" &&
    s.graph !== null &&
    typeof s.state === "object" &&
    s.state !== null
  );
}
