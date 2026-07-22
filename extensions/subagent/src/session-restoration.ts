import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  VERSION,
  SessionManager,
  type AgentSession,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  RestoreFailureReason,
  ResumeExtensionIdentity,
  ResumeRuntimeSnapshot,
  ResumeTargetV1,
} from "./types.js";

const inFlight = new Set<string>();
const SHA256_RE = /^[0-9a-f]{64}$/;

export class SessionRestoreError extends Error {
  constructor(public readonly reason: RestoreFailureReason, message: string) {
    super(message);
    this.name = "SessionRestoreError";
  }
}

export interface ValidatedChildSession {
  sessionFile: string;
  sessionDir: string;
  sessionSha256: string;
  entryCount: number;
  activeLeafId: string;
  entries: SessionEntry[];
  stat: { size: number; mtimeMs: number };
  reconciledDescendant: boolean;
}

export type AuthenticatedSuffixRecoveryOutcome =
  | "empty"
  | "metadata_only"
  | "clean_final_assistant"
  | "completed_tool_chain"
  | "user_only"
  | "pending_tool_call"
  | "tool_result_without_final_assistant"
  | "abnormal_assistant_stop"
  | "malformed"
  | "nonlinear_suffix";

export type AuthenticatedSuffixRecoveryClassification = {
  outcome: AuthenticatedSuffixRecoveryOutcome;
  recoverable: boolean;
  reconstructedResult?: string;
  failureReason?: Extract<RestoreFailureReason, "session_corrupt_or_unsupported" | "unsafe_interrupted_operation">;
};

export interface RuntimeCompatibilityInput {
  model: { provider: string; id: string; api: string };
  thinkingLevel: ResumeRuntimeSnapshot["thinkingLevel"];
  promptMode: ResumeRuntimeSnapshot["promptMode"];
  isolated: boolean;
  inheritContext: boolean;
  systemPrompt: string;
  resourcePolicy: unknown;
  agentConfig: unknown;
  extensions: Array<{ name: string; path?: string; content?: string }>;
  activeToolNames: string[];
}

export interface RestoreAgentSessionOptions {
  target: ResumeTargetV1;
  runtime: ResumeRuntimeSnapshot;
  createSession: (manager: SessionManager) => Promise<AgentSession>;
  bindAndApplyPolicy?: (session: AgentSession) => Promise<void>;
  sessionManagerOpen?: typeof SessionManager.open;
  /** Test seam: runs before the mandatory final stat/hash check. */
  beforeFinalRevalidation?: () => void;
}

export interface PreparedAgentSessionRestore {
  runtime: ResumeRuntimeSnapshot;
  restore: () => Promise<AgentSession>;
}

/** Bind a prepared current-runtime snapshot to strict persisted-session restoration. */
export function prepareAgentSessionRestore(
  options: RestoreAgentSessionOptions,
 ): PreparedAgentSessionRestore {
  return {
    runtime: options.runtime,
    restore: () => restoreAgentSession(options),
  };
}

interface RestoreLockOwner {
  pid: number;
  createdAt: string;
  token: string;
}

function fail(reason: RestoreFailureReason, message: string): never {
  throw new SessionRestoreError(reason, message);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function stableSha256(value: string | Uint8Array | unknown): string {
  const bytes = typeof value === "string" || value instanceof Uint8Array
    ? value
    : JSON.stringify(stableValue(value));
  return createHash("sha256").update(bytes).digest("hex");
}

export function redactSessionReference(sessionFile: string): string {
  return `session:${stableSha256(resolve(sessionFile)).slice(0, 12)}`;
}

export function buildRuntimeCompatibilitySnapshot(input: RuntimeCompatibilityInput): ResumeRuntimeSnapshot {
  const extensionIdentities: ResumeExtensionIdentity[] = input.extensions
    .map((extension) => ({
      name: extension.name,
      contentHash: stableSha256(extension.content ?? readFileSync(extension.path!, "utf8")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.contentHash.localeCompare(b.contentHash));
  return {
    piVersion: VERSION,
    model: { ...input.model },
    thinkingLevel: input.thinkingLevel,
    promptMode: input.promptMode,
    isolated: input.isolated,
    inheritContext: input.inheritContext,
    systemPromptHash: stableSha256(input.systemPrompt),
    resourcePolicyHash: stableSha256(input.resourcePolicy),
    agentConfigHash: stableSha256(input.agentConfig),
    extensionIdentities,
    activeToolNames: [...new Set(input.activeToolNames)].sort(),
  };
}

export function compareRuntimeCompatibilitySnapshot(
  expected: ResumeRuntimeSnapshot,
  actual: ResumeRuntimeSnapshot,
): void {
  if (stableSha256(expected.model) !== stableSha256(actual.model)) {
    fail("model_unavailable", "Persisted session model is unavailable in current runtime");
  }
  if (stableSha256(expected.extensionIdentities) !== stableSha256(actual.extensionIdentities) ||
      stableSha256(expected.activeToolNames) !== stableSha256(actual.activeToolNames)) {
    fail("tools_extensions_incompatible", "Persisted session tools or extensions are incompatible with current runtime");
  }
  const expectedAgentConfig = {
    piVersion: expected.piVersion,
    thinkingLevel: expected.thinkingLevel,
    promptMode: expected.promptMode,
    isolated: expected.isolated,
    inheritContext: expected.inheritContext,
    systemPromptHash: expected.systemPromptHash,
    resourcePolicyHash: expected.resourcePolicyHash,
    agentConfigHash: expected.agentConfigHash,
  };
  const actualAgentConfig = {
    piVersion: actual.piVersion,
    thinkingLevel: actual.thinkingLevel,
    promptMode: actual.promptMode,
    isolated: actual.isolated,
    inheritContext: actual.inheritContext,
    systemPromptHash: actual.systemPromptHash,
    resourcePolicyHash: actual.resourcePolicyHash,
    agentConfigHash: actual.agentConfigHash,
  };
  if (stableSha256(expectedAgentConfig) !== stableSha256(actualAgentConfig)) {
    fail("agent_config_unavailable", "Persisted session agent configuration is unavailable in current runtime");
  }
}

interface StrictJsonLines {
  values: unknown[];
  lineEnds: number[];
}

function strictJsonLines(bytes: Buffer): StrictJsonLines {
  if (bytes.length === 0) fail("session_corrupt_or_unsupported", "Session file is empty");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("session_corrupt_or_unsupported", "Session file is not valid UTF-8");
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    fail("session_corrupt_or_unsupported", "Session file contains empty or missing JSONL entries");
  }
  const lineEnds: number[] = [];
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0a) lineEnds.push(index + 1);
  }
  if (bytes.at(-1) !== 0x0a) lineEnds.push(bytes.length);
  try {
    return { values: lines.map((line) => JSON.parse(line)), lineEnds };
  } catch {
    fail("session_corrupt_or_unsupported", "Session file contains invalid JSONL");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  let cursor: SessionEntry | undefined = entries.at(-1);
  while (cursor) {
    branch.push(cursor);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  return branch.reverse();
}

function validateActiveBranch(
  entries: SessionEntry[],
  runtime: ResumeRuntimeSnapshot,
  allowInterruptedSuffix = false,
): void {
  const branch = activeBranch(entries);
  const modelChanges = branch.filter((entry) => entry.type === "model_change") as Array<SessionEntry & { provider: string; modelId: string }>;
  const thinkingChanges = branch.filter((entry) => entry.type === "thinking_level_change") as Array<SessionEntry & { thinkingLevel: string }>;
  if (modelChanges.some((entry) => typeof entry.provider !== "string" || typeof entry.modelId !== "string") ||
      thinkingChanges.some((entry) => typeof entry.thinkingLevel !== "string")) {
    fail("session_corrupt_or_unsupported", "Session model or thinking entries are invalid");
  }
  const model = modelChanges.at(-1);
  if (model && (model.provider !== runtime.model.provider || model.modelId !== runtime.model.id)) {
    fail("model_unavailable", "Active branch model differs from target runtime");
  }
  const thinking = thinkingChanges.at(-1);
  if (thinking && thinking.thinkingLevel !== runtime.thinkingLevel) {
    fail("agent_config_unavailable", "Active branch thinking level differs from target runtime");
  }
  if (allowInterruptedSuffix) return;

  const pendingToolCalls = new Set<string>();
  let lastMessageRole: string | undefined;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = (entry as SessionEntry & { message?: Record<string, unknown> }).message;
    if (!isRecord(message) || typeof message.role !== "string") {
      fail("session_corrupt_or_unsupported", "Session message entry is invalid");
    }
    lastMessageRole = message.role;
    if (message.role === "assistant") {
      if (message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "length") {
        fail("unsafe_interrupted_operation", "Session contains an interrupted assistant response");
      }
      if (!Array.isArray(message.content)) {
        fail("session_corrupt_or_unsupported", "Assistant message content is invalid");
      }
      let toolCallCount = 0;
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== "toolCall") continue;
        if (typeof part.id !== "string" || !part.id || pendingToolCalls.has(part.id)) {
          fail("unsafe_interrupted_operation", "Session contains invalid tool-call state");
        }
        pendingToolCalls.add(part.id);
        toolCallCount++;
      }
      if (message.stopReason === "toolUse" && toolCallCount === 0) {
        fail("unsafe_interrupted_operation", "Session contains incomplete provider tool state");
      }
    } else if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !pendingToolCalls.delete(message.toolCallId)) {
        fail("unsafe_interrupted_operation", "Session contains unmatched tool result state");
      }
    }
  }
  if (pendingToolCalls.size > 0 || lastMessageRole === "user" || lastMessageRole === "toolResult") {
    fail("unsafe_interrupted_operation", "Session ends with an interrupted operation");
  }
}

function validateTree(
  rawEntries: unknown[],
  target: ResumeTargetV1,
  runtime: ResumeRuntimeSnapshot,
  allowInterruptedSuffix = false,
): SessionEntry[] {
  const header = rawEntries[0];
  if (!isRecord(header) || header.type !== "session") {
    fail("session_corrupt_or_unsupported", "Session has an invalid header");
  }
  if (header.version !== 3 || header.id !== target.childSessionId) {
    fail("session_corrupt_or_unsupported", "Session must start with matching v3 header");
  }
  if (rawEntries.slice(1).some((entry) => isRecord(entry) && entry.type === "session")) {
    fail("session_corrupt_or_unsupported", "Session contains multiple headers");
  }
  const entries = rawEntries.slice(1) as SessionEntry[];
  if (entries.length === 0) fail("session_corrupt_or_unsupported", "Session has no entries");
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id ||
        !(entry.parentId === null || typeof entry.parentId === "string") || typeof entry.type !== "string" ||
        byId.has(entry.id)) {
      fail("session_corrupt_or_unsupported", "Session entries have invalid or duplicate IDs");
    }
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      fail("session_corrupt_or_unsupported", "Session contains orphaned entries");
    }
    const seen = new Set<string>();
    let cursor: SessionEntry | undefined = entry;
    while (cursor) {
      if (seen.has(cursor.id)) fail("session_corrupt_or_unsupported", "Session tree contains a cycle");
      seen.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
  }
  validateActiveBranch(entries, runtime, allowInterruptedSuffix);
  return entries;
}

function confinedPath(target: ResumeTargetV1): { file: string; dir: string } {
  if (!isAbsolute(target.sessionDir) || !isAbsolute(target.sessionFile) ||
      resolve(target.sessionDir) !== target.sessionDir || resolve(target.sessionFile) !== target.sessionFile) {
    fail("scope_mismatch", "Session paths must be absolute normalized paths");
  }
  let dir: string;
  try {
    dir = realpathSync.native(target.sessionDir);
  } catch {
    fail("scope_mismatch", "Persisted session directory is unavailable");
  }
  // A symlinked ANCESTOR (e.g. macOS /var -> /private/var, or a symlinked HOME / PI_CODING_AGENT_DIR)
  // is benign: confinement is enforced below on the realpath'd pair (dirname(file) === dir), which
  // still rejects any session file that is a symlink escaping its recorded directory. Do not re-add a
  // "stored path must equal its own realpath" check here — it breaks legitimate symlinked dirs.
  if (!existsSync(target.sessionFile)) fail("session_file_missing", "Persisted child session is missing");
  let file: string;
  try {
    file = realpathSync.native(target.sessionFile);
  } catch {
    fail("session_file_missing", "Persisted child session is unavailable");
  }
  const rel = relative(dir, file);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel) || dirname(file) !== dir) {
    fail("scope_mismatch", "Session file is outside its recorded directory or uses a symlink");
  }
  return { file, dir };
}

function validateCwd(cwd: string): void {
  try {
    if (!isAbsolute(cwd) || !statSync(realpathSync.native(cwd)).isDirectory()) throw new Error("invalid cwd");
  } catch {
    fail("cwd_unavailable", "Persisted child working directory is unavailable");
  }
}

export function classifyAuthenticatedSuffixRecovery(
  suffix: SessionEntry[],
  snapshotLeafId: string,
 ): AuthenticatedSuffixRecoveryClassification {
  let parentId = snapshotLeafId;
  let sawMetadata = false;
  let sawToolResult = false;
  let finalAssistantText: string | undefined;
  let finalAssistantAfterTool = false;
  let lastMessageRole: string | undefined;
  const pendingToolCalls = new Set<string>();

  for (const entry of suffix) {
    if (entry.parentId !== parentId) {
      return { outcome: "nonlinear_suffix", recoverable: false, failureReason: "session_corrupt_or_unsupported" };
    }
    parentId = entry.id;

    if (entry.type === "session_info") {
      if (typeof entry.timestamp !== "string" || !entry.timestamp ||
          ("name" in entry && entry.name !== undefined && typeof entry.name !== "string")) {
        return { outcome: "malformed", recoverable: false, failureReason: "session_corrupt_or_unsupported" };
      }
      sawMetadata = true;
      continue;
    }

    if (entry.type !== "message") {
      return { outcome: "malformed", recoverable: false, failureReason: "session_corrupt_or_unsupported" };
    }

    const message = (entry as SessionEntry & { message?: Record<string, unknown> }).message;
    if (!isRecord(message) || typeof message.role !== "string") {
      return { outcome: "malformed", recoverable: false, failureReason: "session_corrupt_or_unsupported" };
    }

    lastMessageRole = message.role;
    if (message.role === "user") {
      finalAssistantText = undefined;
      continue;
    }
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !pendingToolCalls.delete(message.toolCallId)) {
        return { outcome: "malformed", recoverable: false, failureReason: "session_corrupt_or_unsupported" };
      }
      sawToolResult = true;
      finalAssistantText = undefined;
      continue;
    }
    if (message.role !== "assistant") {
      return { outcome: "malformed", recoverable: false, failureReason: "session_corrupt_or_unsupported" };
    }
    if (message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "length") {
      return { outcome: "abnormal_assistant_stop", recoverable: false, failureReason: "unsafe_interrupted_operation" };
    }
    if (!Array.isArray(message.content)) {
      return { outcome: "malformed", recoverable: false, failureReason: "session_corrupt_or_unsupported" };
    }
    let toolCallCount = 0;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "toolCall") continue;
      if (typeof part.id !== "string" || !part.id || pendingToolCalls.has(part.id)) {
        return { outcome: "malformed", recoverable: false, failureReason: "session_corrupt_or_unsupported" };
      }
      pendingToolCalls.add(part.id);
      toolCallCount++;
    }
    if (message.stopReason === "toolUse" && toolCallCount === 0) {
      return { outcome: "pending_tool_call", recoverable: false, failureReason: "unsafe_interrupted_operation" };
    }
    if (toolCallCount === 0) {
      finalAssistantText = extractAssistantText(message.content);
      finalAssistantAfterTool = sawToolResult;
    } else {
      finalAssistantText = undefined;
    }
  }

  if (pendingToolCalls.size > 0) {
    return { outcome: "pending_tool_call", recoverable: false, failureReason: "unsafe_interrupted_operation" };
  }
  if (lastMessageRole === "toolResult") {
    return { outcome: "tool_result_without_final_assistant", recoverable: false, failureReason: "unsafe_interrupted_operation" };
  }
  if (lastMessageRole === "user") {
    return { outcome: "user_only", recoverable: false, failureReason: "unsafe_interrupted_operation" };
  }
  if (finalAssistantText !== undefined) {
    return {
      outcome: finalAssistantAfterTool ? "completed_tool_chain" : "clean_final_assistant",
      recoverable: true,
      reconstructedResult: finalAssistantText,
    };
  }
  return { outcome: sawMetadata ? "metadata_only" : "empty", recoverable: true };
}


function inspectPersistedChildSession(
  target: ResumeTargetV1,
  runtime: ResumeRuntimeSnapshot,
  allowInterruptedSuffix: boolean,
): ValidatedChildSession & { classification: AuthenticatedSuffixRecoveryClassification } {
  if (!Number.isSafeInteger(target.entryCount) || target.entryCount < 1) {
    fail("session_corrupt_or_unsupported", "Persisted child session has an invalid snapshot boundary");
  }
  const { file, dir } = confinedPath(target);
  validateCwd(target.cwd);
  const before = statSync(file);
  if (!before.isFile()) fail("session_file_missing", "Persisted child session is not a file");
  const bytes = readFileSync(file);
  const after = statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    fail("target_busy", "Persisted child session changed during validation");
  }
  const raw = strictJsonLines(bytes);
  const rawEntries = raw.values.slice(1);
  if (rawEntries.length < target.entryCount) {
    fail("session_corrupt_or_unsupported", "Persisted child session is shorter than its snapshot");
  }
  const rawBoundary = rawEntries[target.entryCount - 1];
  const prefixEnd = raw.lineEnds[target.entryCount];
  if (!isRecord(rawBoundary) || rawBoundary.id !== target.activeLeafId || prefixEnd === undefined ||
      stableSha256(bytes.subarray(0, prefixEnd)) !== target.sessionSha256) {
    fail("session_corrupt_or_unsupported", "Persisted child session prefix does not match its snapshot");
  }
  const entries = validateTree(raw.values, target, runtime, allowInterruptedSuffix);
  const classification = classifyAuthenticatedSuffixRecovery(entries.slice(target.entryCount), target.activeLeafId);
  if (!allowInterruptedSuffix && !classification.recoverable) {
    fail(classification.failureReason ?? "session_corrupt_or_unsupported", "Persisted child session suffix is unsafe for recovery");
  }
  const activeLeafId = entries.at(-1)!.id;
  const sessionSha256 = stableSha256(bytes);
  return {
    sessionFile: file,
    sessionDir: dir,
    sessionSha256,
    entryCount: entries.length,
    activeLeafId,
    entries,
    stat: { size: after.size, mtimeMs: after.mtimeMs },
    reconciledDescendant: classification.outcome !== "empty",
    classification,
  };
}

export function inspectPersistedChildSessionRecovery(
  target: ResumeTargetV1,
  runtime: ResumeRuntimeSnapshot = target.runtime,
): ValidatedChildSession & { classification: AuthenticatedSuffixRecoveryClassification } {
  return inspectPersistedChildSession(target, runtime, true);
}

export function validatePersistedChildSession(
  target: ResumeTargetV1,
  runtime: ResumeRuntimeSnapshot = target.runtime,
): ValidatedChildSession {
  return inspectPersistedChildSession(target, runtime, false);
}

function isPidLive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLockOwner(lockFile: string): RestoreLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(lockFile, "utf8"));
    if (isRecord(value) && typeof value.pid === "number" && typeof value.createdAt === "string" && typeof value.token === "string") {
      return value as unknown as RestoreLockOwner;
    }
  } catch { /* invalid lock is conservatively busy */ }
  return undefined;
}

function acquireRestoreLock(sessionFile: string): { lockFile: string; owner: RestoreLockOwner } {
  const lockFile = `${sessionFile}.restore.lock`;
  const owner: RestoreLockOwner = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: randomBytes(16).toString("hex"),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(lockFile, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      closeSync(fd);
      return { lockFile, owner };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const current = readLockOwner(lockFile);
      if (attempt === 0 && current && !isPidLive(current.pid)) {
        try {
          if (!lstatSync(lockFile).isSymbolicLink()) rmSync(lockFile);
          else fail("target_busy", "Persisted child session lock is unsafe");
        } catch (removeError) {
          if (removeError instanceof SessionRestoreError) throw removeError;
          fail("target_busy", "Persisted child session lock could not be reclaimed");
        }
        continue;
      }
      fail("target_busy", "Persisted child session is locked");
    }
  }
  fail("target_busy", "Persisted child session is locked");
}

function releaseRestoreLock(lockFile: string, owner: RestoreLockOwner): void {
  const current = readLockOwner(lockFile);
  if (current?.token !== owner.token) return;
  try { rmSync(lockFile); } catch { /* never remove another owner's replacement */ }
}

function revalidateBeforeOpen(validated: ValidatedChildSession): void {
  const bytes = readFileSync(validated.sessionFile);
  const current = statSync(validated.sessionFile);
  if (current.size !== validated.stat.size || current.mtimeMs !== validated.stat.mtimeMs || stableSha256(bytes) !== validated.sessionSha256) {
    fail("target_busy", "Persisted child session changed before open");
  }
}

function reconcileAfterBind(
  validated: ValidatedChildSession,
  target: ResumeTargetV1,
  runtime: ResumeRuntimeSnapshot,
  manager: SessionManager,
): void {
  const before = statSync(validated.sessionFile);
  const bytes = readFileSync(validated.sessionFile);
  const after = statSync(validated.sessionFile);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error("Restored session changed during post-bind reconciliation");
  }
  const raw = strictJsonLines(bytes);
  const rawEntries = raw.values.slice(1);
  const boundary = rawEntries[validated.entryCount - 1];
  const prefixEnd = raw.lineEnds[validated.entryCount];
  if (!isRecord(boundary) || boundary.id !== validated.activeLeafId || prefixEnd === undefined ||
      stableSha256(bytes.subarray(0, prefixEnd)) !== validated.sessionSha256) {
    throw new Error("Bind changed the authenticated pre-bind prefix");
  }

  const entries = validateTree(raw.values, target, runtime);
  let parentId = validated.activeLeafId;
  for (const entry of entries.slice(validated.entryCount)) {
    if (entry.parentId !== parentId) throw new Error("Bind appended nonlinear session entries");
    parentId = entry.id;
  }
  const currentLeafId = entries.at(-1)!.id;
  const currentHash = stableSha256(bytes);
  if (manager.getSessionId() !== target.childSessionId ||
      manager.getEntries().length !== entries.length ||
      manager.getLeafId() !== currentLeafId ||
      stableSha256(readFileSync(validated.sessionFile)) !== currentHash) {
    throw new Error("Bound session manager differs from reconciled session file");
  }
}

export async function restoreAgentSession(options: RestoreAgentSessionOptions): Promise<AgentSession> {
  const key = resolve(options.target.sessionFile);
  if (inFlight.has(key)) fail("target_busy", "Persisted child session is already being restored");
  inFlight.add(key);
  let session: AgentSession | undefined;
  let lock: ReturnType<typeof acquireRestoreLock> | undefined;
  try {
    compareRuntimeCompatibilitySnapshot(options.target.runtime, options.runtime);
    const { file } = confinedPath(options.target);
    lock = acquireRestoreLock(file);
    const validated = validatePersistedChildSession(options.target, options.runtime);
    options.beforeFinalRevalidation?.();
    revalidateBeforeOpen(validated);
    const open = options.sessionManagerOpen ?? SessionManager.open.bind(SessionManager);
    const manager = open(validated.sessionFile, validated.sessionDir, options.target.cwd);
    session = await options.createSession(manager);
    const openedManager = (session as AgentSession & { sessionManager?: SessionManager }).sessionManager ?? manager;
    const finalHash = stableSha256(readFileSync(validated.sessionFile));
    if (openedManager.getSessionId() !== options.target.childSessionId ||
        openedManager.getEntries().length !== validated.entryCount ||
        openedManager.getLeafId() !== validated.activeLeafId || finalHash !== validated.sessionSha256) {
      fail("runtime_initialization_failed", "Opened session differs from validated session");
    }
    await options.bindAndApplyPolicy?.(session);
    try {
      reconcileAfterBind(validated, options.target, options.runtime, openedManager);
    } catch {
      fail("runtime_initialization_failed", "Bound session differs from authenticated session");
    }
    return session;
  } catch (error) {
    session?.dispose?.();
    if (error instanceof SessionRestoreError) throw error;
    throw new SessionRestoreError("runtime_initialization_failed", "Failed to initialize restored session");
  } finally {
    if (lock) releaseRestoreLock(lock.lockFile, lock.owner);
    inFlight.delete(key);
  }
}

export function isStableSessionHash(value: string): boolean {
  return SHA256_RE.test(value);
}
