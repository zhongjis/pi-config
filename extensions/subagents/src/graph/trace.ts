import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import type { InspectionEvent } from "xstate";
import { createSessionArtifactPath, sessionArtifactPath } from "../output-file.js";
import { isGraphRunId } from "./graph-snapshot-path.js";
import type { AgentGraph, GraphNode } from "./ir.js";
import { GRAPH_OUTCOME_KEY, isGraphRunOutcome } from "./outcome.js";
import type { RunGraphResult } from "./run-graph.js";
import type { NodeRun } from "./scheduler.js";

/**
 * Always-on JSONL trace of committed graph state (version 1). Lines are written only from
 * post-commit publication callbacks; it lives beside node transcripts in the exact-session
 * task area and is never referenced from graph history.
 */
export const GRAPH_TRACE_VERSION = 1;
export const GRAPH_TRACE_BYTES = 8 * 1024 * 1024;
export const GRAPH_TRACE_WARNING = "Graph trace is unavailable; execution is unaffected.";
export const GRAPH_RUNTIME_LOG_WARNING = "Graph runtime trace is unavailable; execution is unaffected.";

/** Run-scoped artifact name in the exact-session task area; `kind` keeps sibling logs on one grammar. */
function runArtifactName(runId: string, kind: "trace" | "runtime"): string {
  if (!isGraphRunId(runId)) throw new TypeError("Invalid graph run ID");
  return `${runId}.${kind}.jsonl`;
}
export function graphTracePath(cwd: string, sessionId: string, runId: string): string {
  return sessionArtifactPath(cwd, sessionId, runArtifactName(runId, "trace"));
}
export function createGraphTracePath(cwd: string, sessionId: string, runId: string): string {
  return createSessionArtifactPath(cwd, sessionId, runArtifactName(runId, "trace"));
}

export function graphRuntimeLogPath(cwd: string, sessionId: string, runId: string): string {
  return sessionArtifactPath(cwd, sessionId, runArtifactName(runId, "runtime"));
}
export function createGraphRuntimeLogPath(cwd: string, sessionId: string, runId: string): string {
  return createSessionArtifactPath(cwd, sessionId, runArtifactName(runId, "runtime"));
}

/** JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
/** Output-contract identity. Bounded feedback exposes its work and evaluator schemas. */
export function schemaHash(node: GraphNode): string {
  const schema = node.type === "bounded_feedback" ? { work: node.work.outputSchema ?? null, evaluator: node.evaluator.outputSchema ?? null } : "outputSchema" in node ? node.outputSchema ?? null : null;
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

export interface GraphTrace {
  added(nodeId: string, node: GraphNode): void;
  update(nodeId: string, run: Readonly<NodeRun>): void;
  end(result: Pick<RunGraphResult, "status" | "outputs">): void;
}
export interface GraphTraceOptions {
  /** Creates the directory and returns the file path; failures disable the trace. */
  readonly create: () => string;
  readonly runId: string;
  readonly graph: AgentGraph;
  readonly input: unknown;
  readonly warn: () => void;
  readonly resume?: boolean;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

interface JsonlWriterOptions {
  readonly create: () => string;
  readonly warn: () => void;
  readonly resume?: boolean;
  readonly maxBytes?: number;
  readonly now: () => number;
  /** Buffered bytes before a flush; 0 writes each line synchronously. */
  readonly bufferBytes?: number;
}
/**
 * Shared never-throwing JSONL artifact writer: create/resume, line-number `seq`, one
 * `truncated` line at the cap, and one warning on the first I/O failure.
 */
function openJsonlWriter(options: JsonlWriterOptions) {
  const max = options.maxBytes ?? GRAPH_TRACE_BYTES;
  const threshold = options.bufferBytes ?? 0;
  let path: string | undefined;
  let bytes = 0;
  let seq = 0;
  let open = true;
  let buffer: string[] = [];
  let buffered = 0;
  const fail = (): void => { buffer = []; buffered = 0; if (open) { open = false; options.warn(); } };
  const flush = (): void => {
    if (path === undefined || !buffer.length) return;
    const text = buffer.join("");
    buffer = []; buffered = 0;
    try { appendFileSync(path, text); } catch { fail(); }
  };
  const write = (line: Record<string, unknown>, numbered: boolean): void => {
    if (!open || path === undefined) return;
    try {
      const text = `${JSON.stringify(numbered ? { seq: seq + 1, ...line } : line)}\n`;
      const size = Buffer.byteLength(text);
      if (bytes + size > max) {
        buffer.push(`${JSON.stringify({ type: "truncated", at: options.now() })}\n`);
        open = false;
        flush();
        return;
      }
      buffer.push(text); buffered += size; bytes += size; seq++;
      if (buffered >= threshold) flush();
    } catch { fail(); }
  };
  let existing: string | undefined;
  try {
    path = options.create();
    if (options.resume) try { existing = readFileSync(path, "utf8"); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    if (existing) {
      bytes = Buffer.byteLength(existing);
      const rows = existing.split("\n").filter(Boolean);
      seq = rows.length;
      if (rows.at(-1)?.startsWith('{"type":"truncated"')) open = false;
    }
  } catch { fail(); }
  return { write, flush, resumed: !!existing };
}

/** Never throws: an I/O failure stops writing and warns through the caller's once-per-session hook. */
export function openGraphTrace(options: GraphTraceOptions): GraphTrace {
  const now = options.now ?? Date.now;
  const definitions = new Map<string, GraphNode>();
  const writer = openJsonlWriter({ ...options, now });
  const write = (line: Record<string, unknown>): void => writer.write(line, line.type === "node");
  if (!writer.resumed) write({ type: "header", version: GRAPH_TRACE_VERSION, runId: options.runId, startedAt: now(), graph: options.graph, input: options.input,
    schemaHashes: Object.fromEntries(Object.entries(options.graph.nodes).map(([id, node]) => [id, schemaHash(node)])) });
  if (options.resume) write({ type: "resume", at: now() });
  return {
    added(nodeId, node) { definitions.set(nodeId, node); },
    update(nodeId, run) {
      const node = definitions.get(nodeId);
      definitions.delete(nodeId);
      write({ type: "node", at: now(), event: node ? "added" : "update", nodeId, status: run.status, attempt: run.attempt,
        ...(run.output !== undefined ? { output: run.output } : {}), ...(run.error !== undefined ? { error: run.error } : {}),
        ...(node && !Object.hasOwn(options.graph.nodes, nodeId) ? { node } : {}) });
    },
    end(result) {
      const outcome = result.outputs[GRAPH_OUTCOME_KEY];
      write({ type: "end", at: now(), status: result.status, ...(isGraphRunOutcome(outcome) ? { outcome } : {}) });
    },
  };
}

export interface GraphRuntimeLog {
  readonly inspect: (event: InspectionEvent) => void;
  /** Flushes buffered lines; later inspection events are ignored. */
  readonly close: () => void;
}
/**
 * Opt-in XState inspection log. Records only actor identity, event type, and state value/tags;
 * never context (an owned mutable aggregate) or event payloads, which may carry outputs.
 */
// ponytail: lines buffer up to 64 KiB between flushes, so a process crash can lose that tail;
// flush on checkpoint commit if crash forensics ever need it.
export function openGraphRuntimeLog(options: Omit<JsonlWriterOptions, "now" | "bufferBytes"> & { readonly now?: () => number }): GraphRuntimeLog {
  const now = options.now ?? Date.now;
  const writer = openJsonlWriter({ ...options, now, bufferBytes: 64 * 1024 });
  let closed = false;
  return {
    inspect(event) {
      if (closed || (event.type !== "@xstate.event" && event.type !== "@xstate.microstep")) return;
      try {
        const ref = event.actorRef as { readonly id?: unknown; readonly sessionId: string };
        const snapshot = event.type === "@xstate.microstep" ? event.snapshot as { readonly value?: unknown; readonly tags?: unknown } : undefined;
        const tags = snapshot?.tags instanceof Set && snapshot.tags.size ? [...snapshot.tags].filter(tag => typeof tag === "string") : undefined;
        writer.write({ at: now(), type: event.type, actor: typeof ref.id === "string" ? ref.id : ref.sessionId, session: ref.sessionId, event: String(event.event.type),
          ...(snapshot?.value !== undefined ? { value: snapshot.value } : {}), ...(tags?.length ? { tags } : {}) }, true);
      } catch { /* inspection must never affect execution */ }
    },
    close() { if (!closed) { closed = true; writer.flush(); } },
  };
}
