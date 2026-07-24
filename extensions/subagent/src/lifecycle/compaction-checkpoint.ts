import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentRecord } from "../types.js";
import type { AgentLifecycleLease } from "./agent-lifecycle-store.js";
import { lifecycleSnapshotInput } from "./agent-lifecycle-store.js";
import {
  type AgentLifecycleCheckpointHandle,
  PersistentBgAgentRegistry,
} from "./registry-persistence.js";

export interface SessionFingerprint {
  entryCount: number;
  activeLeafId: string;
  sessionSha256: string;
}

type ReadSessionBytes = (sessionFile: string) => Uint8Array;

class PartialSessionRowError extends Error {}

function parseFingerprint(bytes: Uint8Array): SessionFingerprint {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Child session checkpoint is not valid UTF-8");
  }
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hasTrailingNewline) lines.pop();
  if (lines.length < 2) throw new Error("Child session checkpoint has no active entry");

  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.length === 0) throw new Error("Child session checkpoint contains an empty JSONL row");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1 && !hasTrailingNewline) {
        throw new PartialSessionRowError("Child session checkpoint has a partial JSONL row");
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Child session checkpoint has an invalid JSONL row: ${detail}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Child session checkpoint has an invalid JSONL row: row is not an object");
    }
    rows.push(value as Record<string, unknown>);
  }

  const header = rows[0];
  const entries = rows.slice(1);
  const leaf = entries.at(-1);
  if (header.type !== "session" || header.version !== 3) {
    throw new Error("Child session checkpoint has an unsupported header");
  }
  if (!leaf || typeof leaf.id !== "string" || leaf.id.length === 0) {
    throw new Error("Child session checkpoint has no active leaf");
  }
  return {
    entryCount: entries.length,
    activeLeafId: leaf.id,
    sessionSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function captureSessionFingerprint(
  sessionFile: string,
  readBytes: ReadSessionBytes = readFileSync,
): Promise<SessionFingerprint> {
  let partialError: PartialSessionRowError | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return parseFingerprint(readBytes(sessionFile));
    } catch (error) {
      if (!(error instanceof PartialSessionRowError)) throw error;
      partialError = error;
      if (attempt < 2) await Promise.resolve();
    }
  }
  throw partialError ?? new Error("Child session checkpoint has a partial JSONL row");
}

export async function createLifecycleCheckpointHandle(
  registry: PersistentBgAgentRegistry,
  record: AgentRecord,
  lease: AgentLifecycleLease,
  incrementCompaction = false,
): Promise<AgentLifecycleCheckpointHandle> {
  const current = registry.getResumeTarget(record.id);
  if (!current) throw new Error(`Lifecycle snapshot ${record.id} is unavailable`);
  if (current.state.status !== "running") {
    throw new Error(`Cannot checkpoint terminal lifecycle ${record.id}`);
  }
  const fingerprint = await captureSessionFingerprint(record.sessionFile ?? current.sessionFile);
  return registry.createCheckpointHandle(record.id, lease, {
    ...lifecycleSnapshotInput(current),
    ...fingerprint,
    updatedAt: Date.now(),
    state: {
      status: "running",
      completionDisposition: current.state.completionDisposition ?? "clean",
      resultConsumed: current.state.resultConsumed,
      notified: current.state.notified,
      toolUses: record.toolUses,
      lifetimeUsage: { ...(record.lifetimeUsage ?? current.state.lifetimeUsage) },
      lifetimeCost: record.lifetimeCost ?? current.state.lifetimeCost,
      compactionCount: record.compactionCount ?? current.state.compactionCount,
    },
  }, incrementCompaction);
}
