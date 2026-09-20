import { open, rename, rm } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { ensureSessionLocalRootDirectory, resolveSessionLocalRelativePath } from "../../../session-local/storage.js";
import { collapse } from "./progress.js";
import type { WorkflowTask } from "./task.js";

/** Metadata only. Never an execution checkpoint or a serialized WorkflowTask. */
export interface HistoryNode {
  index: number;
  label: string;
  state: "start" | "progress" | "done" | "error";
  phaseIndex?: number;
  agentType?: string;
  modelId?: string;
  skipped?: boolean;
  blocked?: boolean;
  cached?: boolean;
  queuedAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  attempt?: number;
  lastAttemptReason?: "throttled" | "user-retry" | "stalled" | "loop" | "restore";
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  deps: string[];
}
export interface GraphHistoryRun {
  id: string;
  name: string;
  status: "completed" | "failed" | "killed";
  outcome?: "succeeded" | "partial" | "failed";
  startTime: number;
  endTime: number;
  totalPausedMs: number;
  agentCount: number;
  doneCount: number;
  totalTokens: number;
  totalToolCalls: number;
  replayedCount: number;
  omittedNodeCount: number;
  phases: { index: number; title: string }[];
  nodes: HistoryNode[];
}

export const HISTORY_FILE_BYTES = 8 * 1024 * 1024;
const FILE = "graph-history.json";
const WARNING = "Graph history is unavailable; execution is unaffected.";
const numbers = ["startTime", "endTime", "totalPausedMs", "agentCount", "doneCount", "totalTokens", "totalToolCalls", "replayedCount", "omittedNodeCount"] as const;
const nodeNumbers = ["phaseIndex", "queuedAt", "startedAt", "lastProgressAt", "attempt", "tokens", "toolCalls", "durationMs"] as const;
const nodeStrings = ["agentType", "modelId"] as const;
const nodeBooleans = ["skipped", "blocked", "cached"] as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const historyText = (value: string): string => stripVTControlCharacters(value).replace(/[\s\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+/gu, " ").trim().slice(0, 160);

function decodeNode(value: unknown): HistoryNode | undefined {
  if (!record(value) || !number(value.index) || !Number.isSafeInteger(value.index) || typeof value.label !== "string" ||
    (value.state !== "start" && value.state !== "progress" && value.state !== "done" && value.state !== "error") ||
    !Array.isArray(value.deps) || !value.deps.every(dep => typeof dep === "string")) return;
  const node: HistoryNode = { index: value.index, label: historyText(value.label), state: value.state, deps: value.deps.slice(0, 32).map(historyText) };
  for (const key of nodeNumbers) {
    if (value[key] === undefined) continue;
    if (!number(value[key])) return;
    node[key] = value[key];
  }
  for (const key of nodeStrings) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") return;
    node[key] = historyText(value[key]);
  }
  for (const key of nodeBooleans) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") return;
    node[key] = value[key];
  }
  if (value.lastAttemptReason !== undefined) {
    if (value.lastAttemptReason !== "throttled" && value.lastAttemptReason !== "user-retry" && value.lastAttemptReason !== "stalled" && value.lastAttemptReason !== "loop" && value.lastAttemptReason !== "restore") return;
    node.lastAttemptReason = value.lastAttemptReason;
  }
  return node;
}

function decodeRun(value: unknown): GraphHistoryRun | undefined {
  if (!record(value) || typeof value.id !== "string" || !historyText(value.id) || typeof value.name !== "string" ||
    (value.status !== "completed" && value.status !== "failed" && value.status !== "killed") ||
    !numbers.every(key => number(value[key])) || !Array.isArray(value.nodes) || !Array.isArray(value.phases)) return;
  if (value.outcome !== undefined && value.outcome !== "succeeded" && value.outcome !== "partial" && value.outcome !== "failed") return;
  const nodes: HistoryNode[] = [];
  const indices = new Set<number>();
  for (const item of value.nodes) {
    const node = decodeNode(item);
    if (!node || indices.has(node.index)) return;
    indices.add(node.index);
    if (nodes.length < 200) nodes.push(node);
  }
  const phases: GraphHistoryRun["phases"] = [];
  for (const item of value.phases) {
    if (!record(item) || !number(item.index) || !Number.isSafeInteger(item.index) || typeof item.title !== "string") return;
    if (phases.length < 64 && !phases.some(phase => phase.index === item.index)) phases.push({ index: item.index, title: historyText(item.title) });
  }
  // This is an explicit allowlist, including when decoding externally modified files.
  return {
    id: historyText(value.id), name: historyText(value.name), status: value.status,
    ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
    startTime: Number(value.startTime), endTime: Number(value.endTime), totalPausedMs: Number(value.totalPausedMs),
    agentCount: Number(value.agentCount), doneCount: Number(value.doneCount), totalTokens: Number(value.totalTokens),
    totalToolCalls: Number(value.totalToolCalls), replayedCount: Number(value.replayedCount),
    omittedNodeCount: Number(value.omittedNodeCount) + value.nodes.length - nodes.length, phases, nodes,
  };
}

export function snapshotHistory(task: WorkflowTask): GraphHistoryRun | undefined {
  const { agents, phaseTitles } = collapse(task.workflowProgress);
  for (const node of agents) {
    if (node.phaseIndex !== undefined && node.phaseTitle !== undefined) phaseTitles.set(node.phaseIndex, node.phaseTitle);
  }
  for (const [index, phase] of (task.meta?.phases ?? []).entries()) {
    if (!phaseTitles.has(index)) phaseTitles.set(index, phase.title);
  }
  return decodeRun({
    id: task.id, name: task.meta?.name ?? task.workflowName ?? task.id, status: task.status, outcome: task.outcome?.status,
    startTime: task.startTime, endTime: task.endTime, totalPausedMs: task.totalPausedMs,
    agentCount: task.agentCount, doneCount: task.doneCount, totalTokens: task.totalTokens,
    totalToolCalls: task.totalToolCalls, replayedCount: task.replayedCount, omittedNodeCount: 0,
    phases: [...phaseTitles].map(([index, title]) => ({ index, title })), nodes: agents.map(node => ({ ...node, deps: node.deps ?? [] })),
  });
}

const encode = (runs: readonly GraphHistoryRun[]) => JSON.stringify({ version: 1, runs });
export function boundHistory(input: readonly GraphHistoryRun[], maxBytes = HISTORY_FILE_BYTES): GraphHistoryRun[] {
  const seen = new Set<string>();
  const runs = [...input].sort((a, b) => b.startTime - a.startTime).filter(run => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  }).slice(0, 20).map(run => ({ ...run, nodes: [...run.nodes] }));
  while (runs.length > 1 && Buffer.byteLength(encode(runs)) > maxBytes) runs.pop();
  while (runs.length && Buffer.byteLength(encode(runs)) > maxBytes) {
    const newest = runs[0];
    if (!newest.nodes.length) { runs.pop(); break; }
    newest.nodes.pop();
    newest.omittedNodeCount++;
  }
  return runs;
}

export function decodeHistory(text: string): { runs: GraphHistoryRun[]; writable: boolean } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { runs: [], writable: true }; }
  if (!record(value)) return { runs: [], writable: true };
  if (value.version !== undefined && value.version !== 1) return { runs: [], writable: false };
  if (value.version !== 1 || !Array.isArray(value.runs)) return { runs: [], writable: true };
  return { runs: boundHistory(value.runs.map(decodeRun).filter((run): run is GraphHistoryRun => run !== undefined)), writable: true };
}

export class GraphHistoryStore {
  runs: GraphHistoryRun[] = [];
  lifecycleAbortCause?: "reload" | "switch" | "shutdown";
  disableCapture(cause: "reload" | "switch" | "shutdown"): void { this.lifecycleAbortCause = cause; }
  private writable = true;
  private warned = false;
  private pending = Promise.resolve();
  // Deliberately omit getBranch: graph history belongs to the exact Pi session,
  // not the inherited Agent-tree scope used by tool-facing local storage.
  private readonly ctx;
  private constructor(sessionId: string, private readonly warn: (message: string) => void) {
    this.ctx = { sessionManager: { getSessionId: () => sessionId } };
  }
  private warning(): void {
    if (!this.warned) { this.warned = true; this.warn(WARNING); }
  }
  static async load(sessionId: string, warn: (message: string) => void = console.warn): Promise<GraphHistoryStore> {
    const store = new GraphHistoryStore(sessionId, warn);
    try {
      const path = await resolveSessionLocalRelativePath(store.ctx, FILE);
      const file = await open(path, "r");
      try {
        if ((await file.stat()).size > HISTORY_FILE_BYTES) { store.writable = false; store.warning(); return store; }
        const decoded = decodeHistory(await file.readFile("utf8"));
        store.runs = decoded.runs;
        store.writable = decoded.writable;
      } finally { await file.close(); }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") store.warning();
    }
    return store;
  }
  capture(task: WorkflowTask): void {
    if (!this.writable || this.lifecycleAbortCause !== undefined) return;
    if (task.status === "killed" && task.abortController.signal.reason !== "user") return;
    const snapshot = snapshotHistory(task);
    if (!snapshot) return;
    this.runs = boundHistory([snapshot, ...this.runs.filter(run => run.id !== snapshot.id)]);
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
  async flush(): Promise<void> { await this.pending; }
}
