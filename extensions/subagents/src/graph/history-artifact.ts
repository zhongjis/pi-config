import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { outputFilePath } from "../output-file.js";

export interface HistoricalNodeDetail {
  readonly prompt?: string;
  readonly outcome?: string;
}

/** Stable, bounded filename component; no runtime identity or binding participates. */
export function workflowNodeArtifactId(runId: string, index: number): string {
  if (typeof runId !== "string" || !Number.isSafeInteger(index) || index < 0) throw new RangeError("Invalid graph run artifact key");
  return `graph-${createHash("sha256").update(runId, "utf16le").digest("hex")}-${index}`;
}

const MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 16_000;
const MAX_ENTRIES = 10_000;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((block: unknown) => object(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}
function preview(value: string | undefined): string | undefined {
  return value && value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + "\n[truncated preview]" : value;
}

/** Read-only, exact-session lookup. Untrusted/missing artifacts never escape into rendering. */
export function readWorkflowNodeDetail(
  scope: { readonly cwd: string; readonly sessionId: string }, runId: string, index: number,
): HistoricalNodeDetail | undefined {
  try {
    if (!isAbsolute(scope.cwd) || !/^[A-Za-z0-9_-]+$/.test(scope.sessionId)) return undefined;
    const alias = workflowNodeArtifactId(runId, index);
    const path = outputFilePath(scope.cwd, alias, scope.sessionId);
    if (realpathSync(path) !== resolve(path)) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_BYTES) return undefined;
      raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } finally { closeSync(fd); }
    const lines = raw.trimEnd().split("\n");
    if (lines.length > MAX_ENTRIES) return undefined;
    let prompt: string | undefined;
    let outcome: string | undefined;
    for (const [position, line] of lines.entries()) {
      const entry: unknown = JSON.parse(line);
      if (!object(entry) || entry.isSidechain !== true || entry.agentId !== alias || entry.cwd !== scope.cwd || !object(entry.message)) return undefined;
      const message = entry.message;
      switch (entry.type) {
        case "user":
          if (message.role !== "user") return undefined;
          if (position === 0) prompt = text(message.content);
          break;
        case "assistant":
          if (message.role !== "assistant") return undefined;
          outcome = text(message.content) || outcome;
          break;
        case "toolResult":
          if (message.role !== "toolResult") return undefined;
          break;
        default: return undefined;
      }
      if (position === 0 && prompt === undefined) return undefined;
    }
    return { prompt: preview(prompt), outcome: preview(outcome) };
  } catch {
    // Artifact I/O and schema failures are unavailable detail, not panel failures.
    return undefined;
  }
}
