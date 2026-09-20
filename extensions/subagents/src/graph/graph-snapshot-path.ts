import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The workflowRunId contract (including compatible Claude-style run IDs), not a path. */
export function isWorkflowRunId(value: unknown): value is string {
  return typeof value === "string" && /^wf_[a-z0-9-]{6,}$/.test(value);
}

export function snapshotDirectory(cwd: string, create = false): string {
  let directory = realpathSync(cwd);
  for (const part of [".pi", "graph-runs"]) {
    directory = join(directory, part);
    if (!existsSync(directory)) {
      // lstat also catches dangling symlinks, which existsSync follows.
      try { lstatSync(directory); throw new TypeError("Unsafe checkpoint directory"); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      if (create) mkdirSync(directory);
      else continue;
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Unsafe checkpoint directory");
  }
  return directory;
}

export function snapshotPath(cwd: string, runId: string, create = false): string {
  if (!isWorkflowRunId(runId)) throw new TypeError("Invalid workflow run ID");
  const directory = snapshotDirectory(cwd, create);
  const path = join(directory, `${runId}.json`);
  if (dirname(path) !== directory) throw new TypeError("Checkpoint path escapes run directory");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("Unsafe checkpoint file");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return path;
}
