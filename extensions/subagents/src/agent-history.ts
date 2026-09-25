import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { ensureSessionLocalRootDirectory, resolveSessionLocalRelativePath } from "../../session-local/storage.js";
import { historyText } from "./graph/history-topology.js";
import type { AgentRecord } from "./types.js";

/** Public name for the child transcript messages. Same type buildSessionContext returns. */
type AgentMessage = SessionContext["messages"][number];

/** Pointer plus light metadata. Never a prompt, result, error, or output. */
export interface AgentHistoryRun {
  id: string;
  type: string;
  description: string;
  status: "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  startedAt: number;
  completedAt?: number;
  toolUses: number;
  lifetimeUsage: { input: number; output: number; cacheWrite: number };
  sessionFile: string;
}

const FILE = "agent-history.json";
const MAX_RUNS = 50;
const MAX_SESSION_FILE = 4096;
export const AGENT_HISTORY_FILE_BYTES = 1024 * 1024;
const WARNING = "Agent history is unavailable; execution is unaffected.";
const STATUSES = ["running", "queued", "completed", "steered", "aborted", "stopped", "error"] as const;
type PersistedStatus = (typeof STATUSES)[number];
type DecodedRun = Omit<AgentHistoryRun, "status"> & { status: PersistedStatus };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function validSessionFile(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_FILE && isAbsolute(value) && value.endsWith(".jsonl") && !value.includes("\0");
}

function decodeRun(value: unknown): DecodedRun | undefined {
  if (!record(value) || typeof value.id !== "string" || typeof value.type !== "string" || typeof value.description !== "string") return;
  if (typeof value.status !== "string" || !STATUSES.includes(value.status as PersistedStatus)) return;
  if (!finite(value.startedAt) || !finite(value.toolUses) || !validSessionFile(value.sessionFile)) return;
  if (value.completedAt !== undefined && !finite(value.completedAt)) return;
  if (!record(value.lifetimeUsage) || !finite(value.lifetimeUsage.input) || !finite(value.lifetimeUsage.output) || !finite(value.lifetimeUsage.cacheWrite)) return;
  const id = historyText(value.id);
  const type = historyText(value.type);
  if (!id || !type) return;
  return {
    id,
    type,
    description: historyText(value.description),
    status: value.status as PersistedStatus,
    startedAt: value.startedAt,
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
    toolUses: value.toolUses,
    lifetimeUsage: { input: value.lifetimeUsage.input, output: value.lifetimeUsage.output, cacheWrite: value.lifetimeUsage.cacheWrite },
    sessionFile: value.sessionFile,
  };
}

function decodeHistory(text: string): { runs: DecodedRun[]; writable: boolean } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { runs: [], writable: true }; }
  if (!record(value)) return { runs: [], writable: true };
  if (value.version !== undefined && value.version !== 1) return { runs: [], writable: false };
  if (value.version !== 1 || !Array.isArray(value.runs)) return { runs: [], writable: true };
  const seen = new Set<string>();
  const runs: DecodedRun[] = [];
  for (const item of value.runs) {
    const run = decodeRun(item);
    if (!run || seen.has(run.id)) continue;
    seen.add(run.id);
    runs.push(run);
    if (runs.length === MAX_RUNS) break;
  }
  return { runs, writable: true };
}

function snapshot(recordValue: AgentRecord): AgentHistoryRun | undefined {
  if (recordValue.graphRunId !== undefined || recordValue.sessionFile === undefined) return;
  const status = recordValue.status;
  if (status !== "running" && status !== "completed" && status !== "steered" && status !== "aborted" && status !== "stopped" && status !== "error") return;
  const usage = recordValue.lifetimeUsage;
  if (!usage || !finite(usage.input) || !finite(usage.output) || !finite(usage.cacheWrite)) return;
  if (!finite(recordValue.startedAt) || !finite(recordValue.toolUses) || !validSessionFile(recordValue.sessionFile)) return;
  if (recordValue.completedAt !== undefined && !finite(recordValue.completedAt)) return;
  if (typeof recordValue.id !== "string" || typeof recordValue.type !== "string" || typeof recordValue.description !== "string") return;
  const id = historyText(recordValue.id);
  const type = historyText(recordValue.type);
  if (!id || !type) return;
  return {
    id,
    type,
    description: historyText(recordValue.description),
    status,
    startedAt: recordValue.startedAt,
    ...(recordValue.completedAt === undefined ? {} : { completedAt: recordValue.completedAt }),
    toolUses: recordValue.toolUses,
    lifetimeUsage: { input: usage.input, output: usage.output, cacheWrite: usage.cacheWrite },
    sessionFile: recordValue.sessionFile,
  };
}

const encode = (runs: readonly AgentHistoryRun[]) => JSON.stringify({ version: 1, runs });

async function reconcile(runs: readonly DecodedRun[]): Promise<AgentHistoryRun[]> {
  const reconciled: AgentHistoryRun[] = [];
  for (const run of runs) {
    const { status, ...rest } = run;
    if (status === "running" || status === "queued") {
      let completedAt = run.startedAt;
      try {
        const mtime = (await stat(run.sessionFile)).mtimeMs;
        if (finite(mtime)) completedAt = mtime;
      } catch { /* missing or unreadable child file */ }
      reconciled.push({ ...rest, status: "stopped", completedAt });
      continue;
    }
    reconciled.push({ ...rest, status });
  }
  return reconciled;
}

export function mergeAgentHistory(live: AgentRecord[], runs: readonly AgentHistoryRun[]): AgentRecord[] {
  const liveIds = new Set(live.map(item => item.id));
  const history = runs.filter(run => !liveIds.has(run.id)).map((run): AgentRecord => ({
    id: run.id,
    type: run.type,
    description: run.description,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    toolUses: run.toolUses,
    lifetimeUsage: { input: run.lifetimeUsage.input, output: run.lifetimeUsage.output, cacheWrite: run.lifetimeUsage.cacheWrite },
    compactionCount: 0,
    sessionFile: run.sessionFile,
  }));
  return [...live, ...history];
}

/** Read-only. Never opens a SessionManager, which can rewrite legacy files. */
export async function readHistoryConversation(sessionFile: string): Promise<AgentMessage[] | undefined> {
  if (!validSessionFile(sessionFile)) return undefined;
  try {
    const entries = parseSessionEntries(await readFile(sessionFile, "utf8"));
    if (!entries.some(entry => entry.type === "session")) return undefined;
    migrateSessionEntries(entries);
    return buildSessionContext(entries.filter((entry): entry is SessionEntry => entry.type !== "session")).messages;
  } catch {
    return undefined;
  }
}

export class AgentHistoryStore {
  runs: AgentHistoryRun[] = [];
  private writable = true;
  private disabled = false;
  private warned = false;
  private pending = Promise.resolve();
  // Deliberately omit getBranch: independent-agent history belongs to the exact Pi session.
  private readonly ctx;
  private constructor(sessionId: string, private readonly warn: (message: string) => void) {
    this.ctx = { sessionManager: { getSessionId: () => sessionId } };
  }
  private warning(): void {
    if (!this.warned) { this.warned = true; this.warn(WARNING); }
  }
  static async load(sessionId: string, warn: (message: string) => void = console.warn): Promise<AgentHistoryStore> {
    const store = new AgentHistoryStore(sessionId, warn);
    try {
      const path = await resolveSessionLocalRelativePath(store.ctx, FILE);
      const file = await open(path, "r");
      try {
        if ((await file.stat()).size > AGENT_HISTORY_FILE_BYTES) { store.writable = false; store.warning(); return store; }
        const decoded = decodeHistory(await file.readFile("utf8"));
        store.runs = await reconcile(decoded.runs);
        store.writable = decoded.writable;
      } finally { await file.close(); }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") store.warning();
    }
    return store;
  }
  capture(value: AgentRecord): void {
    if (!this.writable || this.disabled) return;
    const next = snapshot(value);
    if (!next) return;
    this.runs = [next, ...this.runs.filter(run => run.id !== next.id)].slice(0, MAX_RUNS);
    const content = encode(this.runs);
    this.pending = this.pending.then(async () => {
      let temporary: string | undefined;
      try {
        await ensureSessionLocalRootDirectory(this.ctx);
        const path = await resolveSessionLocalRelativePath(this.ctx, FILE);
        temporary = await resolveSessionLocalRelativePath(this.ctx, `${FILE}.${process.pid}.tmp`);
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(content, "utf8"); } finally { await file.close(); }
        await rename(temporary, path);
      } catch { this.warning(); }
      finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
    });
  }
  disableCapture(): void { this.disabled = true; }
  async flush(): Promise<void> { await this.pending; }
}
