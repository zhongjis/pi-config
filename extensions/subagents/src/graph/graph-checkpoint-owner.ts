import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeCheckpointAtomic } from "./graph-checkpoint.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function code(error: unknown, expected: string): boolean { return error instanceof Error && "code" in error && error.code === expected; }

/** Linux supplies a boot-scoped process start tick; other platforms fail closed for live PIDs. */
function processStart(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
  } catch (error) {
    if (code(error, "ENOENT") || code(error, "EACCES") || code(error, "EPERM")) return undefined;
    throw error;
  }
}
function owner(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("Unsafe checkpoint owner lock");
  const text = readFileSync(path, "utf8");
  const value: unknown = JSON.parse(text);
  // Legacy PID-only locks can be reclaimed only when that PID is demonstrably dead.
  const pid = typeof value === "number" ? value : record(value) ? value.pid : undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || (record(value) && (typeof value.nonce !== "string" || !value.nonce || (value.start !== undefined && typeof value.start !== "string")))) throw new TypeError("Corrupt checkpoint owner lock; refusing dispatch");
  const start = record(value) && typeof value.start === "string" ? value.start : undefined;
  return { text, pid, start, ino: stat.ino, dev: stat.dev };
}
function live(observed: ReturnType<typeof owner>): boolean {
  try { process.kill(observed.pid, 0); }
  catch (error) { if (code(error, "ESRCH")) return false; throw error; }
  const current = processStart(observed.pid);
  return observed.start === undefined || current === undefined || observed.start === current;
}
function unchanged(path: string, observed: ReturnType<typeof owner>): boolean {
  const current = owner(path);
  return current.text === observed.text && current.ino === observed.ino && current.dev === observed.dev;
}

/** Fully initialized metadata is published atomically, including for recovery guards. */
function acquire(path: string): () => void {
  const metadata = { pid: process.pid, start: processStart(process.pid), nonce: randomUUID() };
  const temporary = `${path}.${metadata.nonce}.owner`;
  try {
    writeFileSync(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    linkSync(temporary, path);
  } catch (error) {
    if (!code(error, "EEXIST")) throw error;
    const observed = owner(path);
    if (live(observed)) throw new TypeError("Checkpoint has a live writer");
    // The same recovery protocol reclaims orphan guards, rather than leaving a permanent deadlock.
    const releaseGuard = acquire(`${path}.recovery`);
    try {
      if (!unchanged(path, observed) || live(observed)) throw new TypeError("Checkpoint owner changed during recovery");
      rmSync(path);
      return acquire(path);
    } finally { releaseGuard(); }
  } finally { rmSync(temporary, { force: true }); }
  const observed = owner(path);
  return () => {
    if (!unchanged(path, observed)) throw new TypeError("Checkpoint owner changed before release");
    rmSync(path);
  };
}

/** Revision and append-only transition checks run under the same exclusive write lock. */
export function writeOwnedCheckpoint(path: string, revision: number | undefined, data: string, validateReplacement?: (previous: unknown) => void): void {
  const release = acquire(`${path}.lock`);
  try {
    if (existsSync(path)) {
      const prior: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!record(prior) || (prior.version !== 1 && prior.version !== 2)) throw new TypeError("Unsupported checkpoint version");
      if (prior.version === 2) {
        if (!record(prior.state) || !record(prior.state.runtime) || typeof prior.state.runtime.revision !== "number" || prior.state.runtime.revision + 1 !== revision) throw new TypeError("Stale checkpoint writer revision");
      } else if (revision !== undefined && revision !== 1) throw new TypeError("Invalid legacy checkpoint upgrade revision");
      validateReplacement?.(prior);
    } else if (revision !== undefined && revision !== 1) throw new TypeError("Missing prior checkpoint revision");
    writeCheckpointAtomic(path, data);
  } finally { release(); }
}

/** A run lease outlives individual writes, preventing live restore owners from dispatching together. */
export function ownCheckpoint(path: string): () => void { return acquire(`${path}.run.lock`); }
