/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DECIMAL_RADIX, JSON_PRETTY_PRINT_SPACES } from "./constants.js";
import { CURRENT_SCHEMA_VERSION, migrate } from "./migrations/v1-to-v2.js";
import type { Task, TaskStatus, TaskStoreData } from "./types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100; // 5s max
const warnedCorruptStorePaths = new Set<string>();

type DagEdgeRejectReason = "self-loop" | "dangling-target" | "cycle";

interface QuarantinedDagEdge {
  from: string;
  to: string;
  reason: DagEdgeRejectReason;
  source: "blocks" | "blockedBy";
}

function warnCorruptStoreOnce(path: string, reason: string): void {
  const key = `tasks-store-corrupt:${path}`;
  if (warnedCorruptStorePaths.has(key)) return;
  warnedCorruptStorePaths.add(key);
  console.warn("[panda-warn]", JSON.stringify({ code: "tasks.store.corrupt", ts: Date.now(), path, reason }));
}

function warnRejectedEdge(from: string, to: string, reason: DagEdgeRejectReason): void {
  console.warn("[panda-warn]", JSON.stringify({ code: "tasks.dag.edge-rejected", ts: Date.now(), from, to, reason }));
}

function warnQuarantinedEdge(path: string, edge: QuarantinedDagEdge): void {
  console.warn("[panda-warn]", JSON.stringify({
    code: "tasks.dag.edge-quarantine",
    ts: Date.now(),
    path,
    from: edge.from,
    to: edge.to,
    reason: edge.reason,
  }));
}

/** Simple file-based locking. */
function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      // O_EXCL: fail if file exists
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // Check for stale lock (process no longer running)
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), DECIMAL_RADIX);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore read errors */ }
        // Wait and retry
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.subject === "string"
    && typeof value.description === "string"
    && isTaskStatus(value.status)
    && (value.activeForm === undefined || typeof value.activeForm === "string")
    && (value.owner === undefined || typeof value.owner === "string")
    && isRecord(value.metadata)
    && isStringArray(value.blocks)
    && isStringArray(value.blockedBy)
    && typeof value.createdAt === "number"
    && typeof value.updatedAt === "number";
}

function isTaskStoreData(value: unknown): value is TaskStoreData {
  if (!isRecord(value)) return false;
  const { nextId, tasks } = value;
  return typeof nextId === "number"
    && Number.isInteger(nextId)
    && nextId >= 1
    && Array.isArray(tasks)
    && tasks.every(isTask);
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;
  private snapshotRoot: string | undefined;

  // In-memory state (always kept in sync)
  private nextId = 1;
  private tasks = new Map<string, Task>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.snapshotRoot = dirname(dirname(filePath));
    this.load();
  }

  /** Read store from disk (file-backed mode only). */
  private load(migrateOnRead = false): void {
    if (!this.filePath) return;
    try {
      if (!existsSync(this.filePath)) {
        this.resetStore();
        return;
      }
      let data: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (migrateOnRead) {
        data = migrate(data, { stateFilePath: this.filePath, snapshotRoot: this.snapshotRoot });
      }
      if (!isTaskStoreData(data)) {
        this.recoverCorruptStore("invalid task store data");
        return;
      }
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const t of data.tasks) {
        this.tasks.set(t.id, t);
      }
      if (this.quarantineInvalidEdges()) {
        try { this.save(); } catch { /* preserve load() never-throw behavior */ }
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        this.resetStore();
        return;
      }
      this.recoverCorruptStore(errorReason(error));
    }
  }

  private resetStore(): void {
    this.nextId = 1;
    this.tasks.clear();
  }

  private recoverCorruptStore(reason: string): void {
    if (!this.filePath) return;
    this.resetStore();
    warnCorruptStoreOnce(this.filePath, reason);
    try {
      if (!existsSync(this.filePath)) return;
      let quarantineTs = Date.now();
      let corruptPath = `${this.filePath}.corrupt-${quarantineTs}`;
      while (existsSync(corruptPath)) {
        quarantineTs++;
        corruptPath = `${this.filePath}.corrupt-${quarantineTs}`;
      }
      renameSync(this.filePath, corruptPath);
    } catch { /* missing/renamed-away corrupt file — treat as absent */ }
  }

  private quarantineInvalidEdges(): boolean {
    if (!this.filePath) return false;
    const quarantined: QuarantinedDagEdge[] = [];
    const candidates: QuarantinedDagEdge[] = [];
    const originalEdges = new Map<string, { blocks: string[]; blockedBy: string[] }>();
    const seenCandidates = new Set<string>();
    const addCandidate = (candidate: QuarantinedDagEdge) => {
      const key = `${candidate.from}\0${candidate.to}`;
      if (seenCandidates.has(key)) return;
      seenCandidates.add(key);
      candidates.push(candidate);
    };
    for (const task of this.tasks.values()) {
      originalEdges.set(task.id, { blocks: [...task.blocks], blockedBy: [...task.blockedBy] });
      for (const to of task.blocks) {
        addCandidate({ from: task.id, to, reason: "cycle", source: "blocks" });
      }
      for (const from of task.blockedBy) {
        addCandidate({ from, to: task.id, reason: "cycle", source: "blockedBy" });
      }
      task.blocks = [];
      task.blockedBy = [];
    }

    for (const candidate of candidates) {
      const reason = this.getEdgeRejectReason(candidate.from, candidate.to);
      if (reason) {
        const edge = { ...candidate, reason };
        quarantined.push(edge);
        warnQuarantinedEdge(this.filePath, edge);
        continue;
      }
      this.insertEdge(candidate.from, candidate.to);
    }

    if (quarantined.length > 0) this.writeQuarantinedEdges(quarantined);
    return quarantined.length > 0 || this.edgeListsChanged(originalEdges);
  }

  private edgeListsChanged(originalEdges: Map<string, { blocks: string[]; blockedBy: string[] }>): boolean {
    for (const task of this.tasks.values()) {
      const original = originalEdges.get(task.id);
      if (!original) return true;
      if (!sameStrings(original.blocks, task.blocks) || !sameStrings(original.blockedBy, task.blockedBy)) return true;
    }
    return false;
  }

  private writeQuarantinedEdges(edges: QuarantinedDagEdge[]): void {
    if (!this.filePath) return;
    try {
      writeFileSync(`${this.filePath}.quarantined-edges.json`, JSON.stringify({
        ts: Date.now(),
        path: this.filePath,
        edges,
      }, null, JSON_PRETTY_PRINT_SPACES));
    } catch { /* forensic write is best-effort; load() must not throw */ }
  }

  private getEdgeRejectReason(from: string, to: string): DagEdgeRejectReason | undefined {
    if (from === to) return "self-loop";
    if (!this.tasks.has(from) || !this.tasks.has(to)) return "dangling-target";
    if (this.hasPath(to, from)) return "cycle";
    return undefined;
  }

  private hasPath(from: string, to: string): boolean {
    const visited = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const task = this.tasks.get(current);
      if (!task) continue;
      for (const next of task.blocks) {
        if (!visited.has(next)) stack.push(next);
      }
    }
    return false;
  }

  private insertEdge(from: string, to: string): void {
    const task = this.tasks.get(from);
    const target = this.tasks.get(to);
    if (!task || !target) return;
    if (!task.blocks.includes(to)) task.blocks.push(to);
    if (!target.blockedBy.includes(from)) target.blockedBy.push(from);
  }

  private rejectEdge(from: string, to: string, warnings: string[]): boolean {
    const reason = this.getEdgeRejectReason(from, to);
    if (!reason) return false;
    warnRejectedEdge(from, to, reason);
    warnings.push(`edge rejected: ${reason} #${from} -> #${to}`);
    return true;
  }

  /** Write store to disk atomically (file-backed mode only). */
  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()),
    };
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, JSON_PRETTY_PRINT_SPACES));
    renameSync(tmpPath, this.filePath);
  }

  /** Execute a mutation with file locking (if file-backed). */
  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load(true); // Re-read latest state (migrate on-disk schema if needed)
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  create(subject: string, description: string, activeForm?: string, metadata?: Record<string, any>): Task {
    return this.withLock(() => {
      const now = Date.now();
      const task: Task = {
        id: String(this.nextId++),
        subject,
        description,
        status: "pending",
        activeForm,
        owner: undefined,
        metadata: metadata ?? {},
        blocks: [],
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(task.id, task);
      return task;
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    return this.tasks.get(id);
  }

  /** List all tasks sorted by ID ascending. */
  list(): Task[] {
    if (this.filePath) this.load();
    return Array.from(this.tasks.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  update(id: string, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, any>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task) return { task: undefined, changedFields: [], warnings: [] };

      const changedFields: string[] = [];
      const warnings: string[] = [];

      // Handle deletion
      if (fields.status === "deleted") {
        this.tasks.delete(id);
        // Clean up dependency edges pointing to this task
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => bid !== id);
          t.blockedBy = t.blockedBy.filter(bid => bid !== id);
        }
        return { task: undefined, changedFields: ["deleted"], warnings: [] };
      }

      if (fields.status !== undefined) {
        task.status = fields.status;
        changedFields.push("status");
      }
      if (fields.subject !== undefined) {
        task.subject = fields.subject;
        changedFields.push("subject");
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
        changedFields.push("description");
      }
      if (fields.activeForm !== undefined) {
        task.activeForm = fields.activeForm;
        changedFields.push("activeForm");
      }
      if (fields.owner !== undefined) {
        task.owner = fields.owner;
        changedFields.push("owner");
      }

      // Metadata: shallow merge, null deletes keys
      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) {
            delete task.metadata[key];
          } else {
            task.metadata[key] = value;
          }
        }
        changedFields.push("metadata");
      }

      // Bidirectional dependency edges
      if (fields.addBlocks && fields.addBlocks.length > 0) {
        for (const targetId of fields.addBlocks) {
          if (this.rejectEdge(id, targetId, warnings)) {
            continue;
          }
          const target = this.tasks.get(targetId)!;
          const wasInserted = !task.blocks.includes(targetId);
          this.insertEdge(id, targetId);
          if (wasInserted) {
            target.updatedAt = Date.now();
          }
        }
        if (task.blocks.some(targetId => fields.addBlocks!.includes(targetId))) changedFields.push("blocks");
      }

      if (fields.addBlockedBy && fields.addBlockedBy.length > 0) {
        for (const targetId of fields.addBlockedBy) {
          if (this.rejectEdge(targetId, id, warnings)) {
            continue;
          }
          const target = this.tasks.get(targetId)!;
          const wasInserted = !task.blockedBy.includes(targetId);
          this.insertEdge(targetId, id);
          if (wasInserted) {
            target.updatedAt = Date.now();
          }
        }
        if (task.blockedBy.some(targetId => fields.addBlockedBy!.includes(targetId))) changedFields.push("blockedBy");
      }

      task.updatedAt = Date.now();
      return { task, changedFields, warnings };
    });
  }

  /** Delete a task by ID. Returns true if deleted. */
  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id)) return false;
      this.tasks.delete(id);
      // Clean up dependency edges
      for (const t of this.tasks.values()) {
        t.blocks = t.blocks.filter(bid => bid !== id);
        t.blockedBy = t.blockedBy.filter(bid => bid !== id);
      }
      return true;
    });
  }

  /** Remove all tasks. */
  clearAll(): number {
    return this.withLock(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      return count;
    });
  }

  /** Delete the backing file (if file-backed and empty). */
  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.tasks.size > 0) return false;
    try { unlinkSync(this.filePath); } catch { /* ignore */ }
    return true;
  }

  /** Remove all completed tasks. */
  clearCompleted(): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, task] of this.tasks) {
        if (task.status === "completed") {
          this.tasks.delete(id);
          count++;
        }
      }
      // Clean up dependency edges for deleted tasks
      if (count > 0) {
        const validIds = new Set(this.tasks.keys());
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => validIds.has(bid));
          t.blockedBy = t.blockedBy.filter(bid => validIds.has(bid));
        }
      }
      return count;
    });
  }
}
