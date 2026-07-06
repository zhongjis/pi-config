import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Static } from "typebox";
import { Type } from "typebox";
import { keyHint, type AgentToolResult, type ExtensionAPI, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
// @ts-expect-error LSP may miss the repo tsconfig path for this vendored package; runtime/test alias resolves it.
import { Text } from "@earendil-works/pi-tui";

const OptionalProjectPath = Type.Optional(Type.String({
  description: "Path to a different project with .codegraph/ initialized. Defaults to the active Pi ctx.cwd.",
}));

const ToolKind = Type.Optional(Type.Union([
  Type.Literal("function"),
  Type.Literal("method"),
  Type.Literal("class"),
  Type.Literal("interface"),
  Type.Literal("type"),
  Type.Literal("variable"),
  Type.Literal("route"),
  Type.Literal("component"),
]));

const ToolDefinitions = [
  {
    name: "codegraph_search",
    label: "CodeGraph Search",
    description: "Locating-only symbol lookup by name (returns positions, not source). For the actual code, prefer codegraph_explore.",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name." }),
      kind: ToolKind,
      limit: Type.Optional(Type.Number({ default: 10 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_callers",
    label: "CodeGraph Callers",
    description: "Find all functions or methods that call a specific symbol. Structural graph query — don't reconstruct with grep.",
    parameters: Type.Object({
      symbol: Type.String(),
      limit: Type.Optional(Type.Number({ default: 20 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_callees",
    label: "CodeGraph Callees",
    description: "Find all functions or methods that a specific symbol calls. Structural graph query — don't reconstruct with grep.",
    parameters: Type.Object({
      symbol: Type.String(),
      limit: Type.Optional(Type.Number({ default: 20 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_impact",
    label: "CodeGraph Impact",
    description: "Analyze the impact radius of changing a symbol. Structural graph query — don't reconstruct with grep.",
    parameters: Type.Object({
      symbol: Type.String(),
      depth: Type.Optional(Type.Number({ default: 2 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description: "Primary tool for understanding code. Returns full source for related symbols grouped by file; treat shown source as already read — do not re-open those files with Read.",
    parameters: Type.Object({
      query: Type.String({ description: "Specific symbols, files, or code terms to explore." }),
      maxFiles: Type.Optional(Type.Number({ default: 12 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_node",
    label: "CodeGraph Node",
    description: "Full detail for one known symbol plus its callers/callees trail. Use instead of Read when you have a symbol name.",
    parameters: Type.Object({
      symbol: Type.String(),
      includeCode: Type.Optional(Type.Boolean({ default: false })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_status",
    label: "CodeGraph Status",
    description: "Inspect CodeGraph index status without initializing or modifying the project.",
    parameters: Type.Object({
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_files",
    label: "CodeGraph Files",
    description: "Project file structure from the CodeGraph index; prefer over ls/find for indexed repos.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      pattern: Type.Optional(Type.String()),
      format: Type.Optional(Type.Union([
        Type.Literal("tree"),
        Type.Literal("flat"),
        Type.Literal("grouped"),
      ], { default: "tree" })),
      includeMetadata: Type.Optional(Type.Boolean({ default: true })),
      maxDepth: Type.Optional(Type.Number()),
      projectPath: OptionalProjectPath,
    }),
  },
] as const;

type ToolName = (typeof ToolDefinitions)[number]["name"];
type ToolParams = Record<string, unknown> & { projectPath?: string };
type JsonRpcRequest = (method: string, params: Record<string, unknown>) => Promise<any>;
type PendingJsonRpcRequests = Map<number, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}>;

type DiagnosticBuffer = { value: string };
type CodeGraphToolDefinition = (typeof ToolDefinitions)[number];
type ToolTheme = Pick<Theme, "fg" | "bold">;
type ToolRenderResult = AgentToolResult<Record<string, unknown> | undefined> & { isError?: boolean };
type CodeGraphRenderOptions = Pick<ToolRenderResultOptions, "expanded" | "isPartial">;
type CodeGraphRenderContext = { args?: ToolParams; isError?: boolean };
type SharedCodeGraphInit = {
  promise: Promise<void>;
  abortController: AbortController;
};

const MaxDiagnosticLength = 1000;
const projectQueues = new Map<string, Promise<void>>();
const codeGraphInitPromises = new Map<string, SharedCodeGraphInit>();
const RequestTimeoutMs = Number(process.env.CODEGRAPH_TIMEOUT_MS) || 30_000;
const InitTimeoutMs = Number(process.env.CODEGRAPH_INIT_TIMEOUT_MS) || 120_000;
const MaxToolCallAttempts = 2;
const ToolCallRetryBackoffMinMs = 250;
const ToolCallRetryBackoffJitterMs = 500;

/**
 * codegraph 1.1.3's multi-threaded parse worker pool crashes under Node 22
 * (web-tree-sitter WASM load inside worker threads → workers die, `codegraph
 * init`/index exits 1 with no error, only fd warnings). Force the single-worker
 * path, which upstream documents as the conservative rollback, unless the user
 * already set an explicit CODEGRAPH_PARSE_WORKERS override.
 */
const CodeGraphSpawnEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CODEGRAPH_PARSE_WORKERS: process.env.CODEGRAPH_PARSE_WORKERS ?? "1",
};

export const codegraphToolNames = ToolDefinitions.map((tool) => tool.name);

function enqueueCodeGraphRequest<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(cwd) ?? Promise.resolve();
  const run = previous.then(task, task);
  const cleanup = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      if (projectQueues.get(cwd) === cleanup) projectQueues.delete(cwd);
    });

  projectQueues.set(cwd, cleanup);
  return run;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCodeGraphUninitializedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "not initialized",
    "not indexed with codegraph",
    "isn't indexed with codegraph",
    "isn’t indexed with codegraph",
    "no .codegraph",
    "missing .codegraph",
    "could not find .codegraph",
    "cannot find .codegraph",
  ].some((snippet) => lower.includes(snippet));
}

function isToolsCallTimeout(error: unknown): boolean {
  return getErrorMessage(error).startsWith('CodeGraph MCP request "tools/call" timed out after ');
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (reason !== undefined) return new Error(String(reason));
  return new Error("CodeGraph request aborted.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError(signal);
}

async function waitForToolCallRetryBackoff(signal: AbortSignal | undefined): Promise<void> {
  const delayMs = ToolCallRetryBackoffMinMs + Math.floor(Math.random() * (ToolCallRetryBackoffJitterMs + 1));

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal ? createAbortError(signal) : new Error("CodeGraph request aborted."));
    };

    if (signal?.aborted) {
      reject(createAbortError(signal));
      return;
    }

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function withToolsCallTimeoutRetry<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MaxToolCallAttempts; attempt += 1) {
    throwIfAborted(signal);

    try {
      return await task();
    } catch (error) {
      if (!isToolsCallTimeout(error)) throw error;

      if (attempt >= MaxToolCallAttempts) {
        throw new Error(`${getErrorMessage(error)} (after ${attempt} attempts)`);
      }

      throwIfAborted(signal);
      await waitForToolCallRetryBackoff(signal);
    }
  }

  throw new Error("CodeGraph tools/call retry loop exhausted.");
}

export async function withCodeGraphMcp<T>(
  projectPath: string | undefined,
  signal: AbortSignal | undefined,
  fn: (request: JsonRpcRequest) => Promise<T>,
): Promise<T> {
  const project = await resolveCodeGraphProject(projectPath);
  const child = spawn("codegraph", ["serve", "--mcp", "--path", project.cwd], {
    cwd: project.cwd,
    env: CodeGraphSpawnEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return runJsonRpcSession(child, project.cwd, signal, fn);
}

function isDirectorySync(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isValidCodeGraphMarker(candidate: string): boolean {
  if (!isDirectorySync(candidate)) return false;

  let entries: string[];
  try {
    entries = readdirSync(candidate);
  } catch {
    return false;
  }

  return entries.length === 0 || entries.includes(".gitignore") || entries.includes("codegraph.db");
}

function findGitBoundary(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  let parent = path.dirname(current);
  while (current !== parent) {
    if (existsSync(path.join(current, ".git"))) return current;
    current = parent;
    parent = path.dirname(current);
  }
  return existsSync(path.join(current, ".git")) ? current : undefined;
}

function isImplicitUnsafeAncestor(candidate: string, startDir: string): boolean {
  if (candidate === startDir) return false;
  const parent = path.dirname(candidate);
  return candidate === os.homedir() || candidate === parent;
}

function findCodeGraphRoot(startDir: string): string | undefined {
  const canonicalStartDir = path.resolve(startDir);
  const boundary = findGitBoundary(canonicalStartDir);
  let current = canonicalStartDir;
  let parent = path.dirname(current);

  while (true) {
    if (isValidCodeGraphMarker(path.join(current, ".codegraph"))) {
      return isImplicitUnsafeAncestor(current, canonicalStartDir) ? undefined : current;
    }
    if (current === boundary || current === parent) return undefined;
    current = parent;
    parent = path.dirname(current);
  }
}

export type ResolvedCodeGraphProject = {
  /** Canonical cwd used for CodeGraph serve/init and same-project queue keys. */
  cwd: string;
  /** True when cwd resolved from an existing .codegraph marker at or above the requested dir. */
  hasCodeGraphMarker: boolean;
};

export async function resolveCodeGraphProject(projectPath: string | undefined): Promise<ResolvedCodeGraphProject> {
  const cwd = projectPath || process.cwd();

  if (!path.isAbsolute(cwd)) {
    throw new Error("CodeGraph projectPath must be an absolute path.");
  }

  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new Error("CodeGraph projectPath does not exist or is not accessible.");
  }

  if (!info.isDirectory()) {
    throw new Error("CodeGraph projectPath must point to a directory.");
  }

  const canonicalCwd = path.resolve(cwd);
  const markerRoot = findCodeGraphRoot(canonicalCwd);
  return {
    cwd: markerRoot ?? canonicalCwd,
    hasCodeGraphMarker: markerRoot !== undefined,
  };
}

export async function resolveProjectCwd(projectPath: string | undefined): Promise<string> {
  return (await resolveCodeGraphProject(projectPath)).cwd;
}

export async function initCodeGraphProject(root: string | undefined, signal?: AbortSignal): Promise<void> {
  const project = await resolveCodeGraphProject(root);
  const canonicalRoot = project.cwd;
  throwIfAborted(signal);

  let entry = codeGraphInitPromises.get(canonicalRoot);
  if (!entry) {
    const abortController = new AbortController();
    const promise = runCodeGraphInit(canonicalRoot, abortController.signal).catch((error) => {
      if (codeGraphInitPromises.get(canonicalRoot)?.promise === promise) {
        codeGraphInitPromises.delete(canonicalRoot);
      }
      throw error;
    });
    entry = { promise, abortController };
    codeGraphInitPromises.set(canonicalRoot, entry);
  }

  return waitForCodeGraphInit(entry, signal);
}

async function waitForCodeGraphInit(entry: SharedCodeGraphInit, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return entry.promise;

  const onAbort = () => {
    entry.abortController.abort(createAbortError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return entry.promise.finally(() => signal.removeEventListener("abort", onAbort));
}

function runCodeGraphInit(root: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("codegraph", ["init", root], {
      cwd: root,
      env: CodeGraphSpawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: DiagnosticBuffer = { value: "" };
    const stderr: DiagnosticBuffer = { value: "" };
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error, killChild = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (killChild && !child.killed) child.kill();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      finish(createCodeGraphInitAbortError(root, signal, stdout.value, stderr.value), true);
    };
    const timer = setTimeout(() => {
      finish(createCodeGraphInitTimeoutError(root, stdout.value, stderr.value), true);
    }, InitTimeoutMs);
    timer.unref();

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.on("data", (chunk) => appendDiagnosticChunk(stdout, chunk));
    child.stderr.on("data", (chunk) => appendDiagnosticChunk(stderr, chunk));
    child.on("error", (error) => {
      finish(createCodeGraphInitFailureError(root, error.message, stdout.value, stderr.value));
    });
    child.on("exit", (code, exitSignal) => {
      if (code === 0) {
        finish();
        return;
      }
      const reason = code === null
        ? `terminated by signal ${exitSignal ?? "unknown"}`
        : `exited with code ${code}`;
      finish(createCodeGraphInitFailureError(root, reason, stdout.value, stderr.value));
    });
  });
}

function appendDiagnosticChunk(target: DiagnosticBuffer, chunk: Buffer): void {
  const next = `${target.value}${chunk.toString("utf-8")}`;
  target.value = next.length > MaxDiagnosticLength * 2
    ? next.slice(-MaxDiagnosticLength * 2)
    : next;
}

function createCodeGraphInitAbortError(root: string, signal: AbortSignal, stdout: string, stderr: string): Error {
  return createCodeGraphInitFailureError(
    root,
    `aborted: ${getErrorMessage(createAbortError(signal))}`,
    stdout,
    stderr,
  );
}

function createCodeGraphInitTimeoutError(root: string, stdout: string, stderr: string): Error {
  return createCodeGraphInitFailureError(root, `timed out after ${InitTimeoutMs}ms`, stdout, stderr);
}

function createCodeGraphInitFailureError(root: string, reason: string, stdout: string, stderr: string): Error {
  const diagnostics = formatCodeGraphInitDiagnostics(stdout, stderr);
  return new Error(`CodeGraph init failed for ${root}: ${reason}${diagnostics}`);
}

function formatCodeGraphInitDiagnostics(stdout: string, stderr: string): string {
  const parts = [
    formatCodeGraphDiagnosticStream("stderr", stderr),
    formatCodeGraphDiagnosticStream("stdout", stdout),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

function formatCodeGraphDiagnosticStream(label: "stdout" | "stderr", value: string): string | undefined {
  const diagnostic = sanitizeDiagnostic(value.trim());
  return diagnostic ? `${label}: ${diagnostic}` : undefined;
}

export function normalizeFilesPath(inputPath?: string, projectCwd?: string): string | undefined {
  if (typeof inputPath !== "string" || inputPath.trim() === "") return undefined;

  const trimmed = inputPath.trim();
  let expanded = trimmed;
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }

  if (projectCwd && path.isAbsolute(expanded)) {
    const relative = path.relative(projectCwd, expanded);
    if (relative === "") return undefined;
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
  }

  return trimmed.split(path.sep).join("/");
}

const EmptyFilesMarker = "No files found matching the criteria.";

export function annotateFilesResult(resultText: string, originalPath?: string): string {
  if (!originalPath || !resultText.includes(EmptyFilesMarker)) return resultText;

  return `${resultText}\n\nHint: codegraph_files interprets "path" as a root-relative POSIX prefix (e.g. "src/components"). The filter "${originalPath}" did not match any indexed path.`;
}

export function sanitizeDiagnostic(value: string): string {
  const withoutAnsi = value.replace(/\u001b\[[0-9;]*m/g, "");
  const redacted = withoutAnsi
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|AUTH)[A-Z0-9_]*=)\S+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/--(?:token|secret|password|api-key|apikey|otp)(?:=|\s+)\S+/gi, "--[redacted]");

  return redacted.length > MaxDiagnosticLength
    ? `${redacted.slice(0, MaxDiagnosticLength)}...`
    : redacted;
}

async function runJsonRpcSession<T>(
  child: ChildProcessWithoutNullStreams,
  cwd: string,
  signal: AbortSignal | undefined,
  fn: (request: JsonRpcRequest) => Promise<T>,
): Promise<T> {
  const pending: PendingJsonRpcRequests = new Map();
  const stderr = { value: "" };
  const cleanup = () => cleanupJsonRpcChild(child, pending);
  const onAbort = () => cleanup();

  signal?.addEventListener("abort", onAbort, { once: true });
  attachJsonRpcHandlers(child, pending, stderr);

  try {
    const sendRequest = createJsonRpcRequestSender(child, pending);
    await initializeJsonRpcSession(cwd, sendRequest, sendJsonRpcNotification.bind(undefined, child));
    return await fn(sendRequest);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cleanup();
  }
}

function cleanupJsonRpcChild(
  child: ChildProcessWithoutNullStreams,
  pending: PendingJsonRpcRequests,
): void {
  rejectPendingJsonRpcRequests(
    pending,
    new Error("CodeGraph MCP process closed before responding."),
  );
  if (!child.killed) child.kill();
}

function rejectPendingJsonRpcRequests(
  pending: PendingJsonRpcRequests,
  error: Error,
): void {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function attachJsonRpcHandlers(
  child: ChildProcessWithoutNullStreams,
  pending: PendingJsonRpcRequests,
  stderr: { value: string },
): void {
  const stdout = { value: "" };

  child.stdout.on("data", (chunk) => {
    handleJsonRpcStdout(chunk, stdout, pending);
  });
  child.stderr.on("data", (chunk) => {
    stderr.value += chunk.toString("utf-8");
  });
  child.on("error", (err) => rejectPendingJsonRpcRequests(pending, err));
  child.on("exit", (code) => rejectPendingJsonRpcOnExit(pending, stderr.value, code));
}

function handleJsonRpcStdout(
  chunk: Buffer,
  stdout: { value: string },
  pending: PendingJsonRpcRequests,
): void {
  stdout.value += chunk.toString("utf-8");
  let newline = stdout.value.indexOf("\n");
  while (newline !== -1) {
    const line = stdout.value.slice(0, newline).trim();
    stdout.value = stdout.value.slice(newline + 1);
    if (line) resolveJsonRpcLine(line, pending);
    newline = stdout.value.indexOf("\n");
  }
}

function resolveJsonRpcLine(line: string, pending: PendingJsonRpcRequests): void {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.id === undefined || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id)!;
  pending.delete(msg.id);
  if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
  else resolve(msg.result);
}

function rejectPendingJsonRpcOnExit(
  pending: PendingJsonRpcRequests,
  stderr: string,
  code: number | null,
): void {
  if (pending.size === 0) return;
  const diagnostic = sanitizeDiagnostic(stderr.trim());
  const msg = diagnostic || `CodeGraph MCP process exited with code ${code}`;
  rejectPendingJsonRpcRequests(pending, new Error(msg));
}

function createJsonRpcRequestSender(
  child: ChildProcessWithoutNullStreams,
  pending: PendingJsonRpcRequests,
): JsonRpcRequest {
  let nextId = 1;
  return (method, params) => {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error(`CodeGraph MCP request "${method}" timed out after ${RequestTimeoutMs}ms.`));
      }, RequestTimeoutMs);
      timer.unref();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  };
}

function sendJsonRpcNotification(
  child: ChildProcessWithoutNullStreams,
  method: string,
  params: Record<string, unknown>,
): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function initializeJsonRpcSession(
  cwd: string,
  sendRequest: JsonRpcRequest,
  sendNotification: (method: string, params: Record<string, unknown>) => void,
): Promise<void> {
  const rootUri = pathToFileURL(cwd).href;
  await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: cwd.split(/[\\/]/).pop() || cwd }],
    capabilities: {},
    clientInfo: { name: "pi-codegraph", version: "0.1.0" },
  });
  sendNotification("initialized", {});
}

async function prepareToolArguments(
  name: ToolName,
  params: ToolParams,
): Promise<{ args: ToolParams; originalFilesPath?: string }> {
  if (name !== "codegraph_files") return { args: params };

  const projectPath = typeof params.projectPath === "string" ? params.projectPath : undefined;
  const project = await resolveCodeGraphProject(projectPath);
  const originalFilesPath = typeof params.path === "string" ? params.path : undefined;
  const normalizedPath = normalizeFilesPath(originalFilesPath, project.cwd);

  const args: ToolParams = { ...params };
  if (normalizedPath === undefined) {
    delete args.path;
  } else {
    args.path = normalizedPath;
  }

  return { args, originalFilesPath };
}

function canonicalizeMcpToolArguments(args: ToolParams, project: ResolvedCodeGraphProject): ToolParams {
  if (!project.hasCodeGraphMarker || typeof args.projectPath !== "string") return args;
  return { ...args, projectPath: project.cwd };
}

function getToolResultText(result: any): string {
  return (result?.content || [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}

function styleToolTitle(theme: ToolTheme, text: string): string {
  const bold = theme.bold ? theme.bold(text) : text;
  return theme.fg ? theme.fg("toolTitle", bold) : bold;
}

function styleMuted(theme: ToolTheme, text: string): string {
  return theme.fg ? theme.fg("muted", text) : text;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function shortenPathForDisplay(value: string): string {
  const normalized = value.split(/[\\/]+/).filter(Boolean);
  if (normalized.length <= 2) return value;
  return normalized.slice(-2).join("/");
}

function formatArgValue(key: string, value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return key === "projectPath" ? shortenPathForDisplay(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function renderCodeGraphCall(tool: CodeGraphToolDefinition, args: ToolParams, theme: ToolTheme): Text {
  const argOrder = ["query", "symbol", "path", "format", "includeCode", "projectPath"] as const;
  const parts = argOrder
    .map((key) => {
      const value = formatArgValue(key, args[key]);
      if (!value) return undefined;
      return key === "projectPath" ? `project: ${value}` : `${key}: ${value}`;
    })
    .filter((part): part is string => Boolean(part));
  const suffix = parts.length > 0 ? ` · ${styleMuted(theme, parts.join(" · "))}` : "";
  return new Text(`▸ ${styleToolTitle(theme, tool.name)}${suffix}`, 0, 0);
}

function getResultText(result: ToolRenderResult | undefined): string {
  return (result?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function countResultLines(text: string): number {
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

function getFirstMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function stripMarkdown(value: string): string {
  return value.replace(/\*\*([^*]+)\*\*/g, "$1").trim();
}

function parseMarkdownHeading(text: string): { name: string; kind?: string } | undefined {
  const firstLine = getFirstMeaningfulLine(text);
  if (!firstLine) return undefined;
  const match = /^\*\*([^*]+)\*\*\s*(?:\(([^)]+)\))?/.exec(firstLine);
  if (!match) return undefined;
  return { name: match[1], kind: match[2] };
}

function collectBacktickedPaths(text: string): string[] {
  const paths = new Set<string>();
  const pathPattern = /`([^`\n]+)`/g;
  let match = pathPattern.exec(text);
  while (match !== null) {
    const candidate = match[1];
    if (candidate.includes("/") || /\.[A-Za-z0-9]+(?::\d+)?$/.test(candidate)) paths.add(candidate);
    match = pathPattern.exec(text);
  }
  return [...paths];
}


function prefixTreeLines(lines: string[]): string[] {
  return lines.map((line, index) => {
    const prefix = index === lines.length - 1 ? "└─" : "├─";
    return `${prefix} ${line}`;
  });
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1];
}

function collectBoldEntries(text: string, limit: number): string[] {
  const entries: string[] = [];
  const pattern = /^\*\*([^*]+)\*\*(?: \(([^)]+)\))?/gm;
  let match = pattern.exec(text);
  while (match && entries.length < limit) {
    entries.push(match[2] ? `${match[1]} (${match[2]})` : match[1]);
    match = pattern.exec(text);
  }
  return entries;
}

function collectBulletEntries(text: string, limit: number): string[] {
  const entries: string[] = [];
  const pattern = /^-\s+(.+)$/gm;
  let match = pattern.exec(text);
  while (match && entries.length < limit) {
    entries.push(stripMarkdown(match[1]));
    match = pattern.exec(text);
  }
  return entries;
}

function countListWithMore(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const more = /\+(\d+) more/.exec(value)?.[1];
  const visible = value.split(",").filter((part) => part.trim() && !part.includes("+"));
  return visible.length + (more ? Number(more) : 0);
}

function getSection(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  if (startIndex === -1) return "";
  const endIndex = text.indexOf(end, startIndex + start.length);
  return endIndex === -1 ? text.slice(startIndex) : text.slice(startIndex, endIndex);
}

function summarizeStatus(text: string): string[] {
  const files = firstMatch(text, /\*\*Files indexed:\*\*\s*([^\n]+)/);
  const nodes = firstMatch(text, /\*\*Total nodes:\*\*\s*([^\n]+)/);
  const db = firstMatch(text, /\*\*Database size:\*\*\s*([^\n]+)/);
  const backend = firstMatch(text, /\*\*Backend:\*\*\s*([^\n—]+)/);
  const languages = collectBulletEntries(getSection(text, "**Languages:**", "\n\n"), 3);
  return [
    files && nodes ? `index: ${files} files · ${nodes} nodes${db ? ` · ${db}` : ""}` : undefined,
    backend ? `backend: ${backend.trim()}` : undefined,
    languages.length > 0 ? `languages: ${languages.join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function summarizeFiles(text: string, args: ToolParams): string[] {
  const count = firstMatch(text, /Project Structure \(([^)]+)\)/);
  const pathArg = formatArgValue("path", args.path);
  const format = formatArgValue("format", args.format);
  return [
    count ? `structure: ${count}` : undefined,
    pathArg ? `path: ${pathArg}` : undefined,
    format ? `format: ${format}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function summarizeSearch(text: string): string[] {
  const count = firstMatch(text, /Search Results \(([^)]+)\)/);
  const top = collectBoldEntries(text, 3);
  return [
    count ? `matches: ${count}` : undefined,
    top.length > 0 ? `top: ${top.join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function summarizeNode(text: string): string[] {
  const location = firstMatch(text, /\*\*Location:\*\*\s*([^\n]+)/);
  const calls = countListWithMore(firstMatch(text, /\*\*Calls →\*\*\s*([^\n]+)/));
  const calledBy = countListWithMore(firstMatch(text, /\*\*Called by ←\*\*\s*([^\n]+)/));
  return [
    location ? `location: ${location}` : undefined,
    calls !== undefined ? `calls: ${calls}` : undefined,
    calledBy !== undefined ? `called by: ${calledBy}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function summarizeCallList(text: string, noun: string): string[] {
  const count = firstMatch(text, /\(([^)]+)\)/);
  const top = collectBulletEntries(text, 3);
  return [
    count ? `${noun}: ${count}` : undefined,
    top.length > 0 ? `top: ${top.join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function summarizeImpact(text: string): string[] {
  const count = firstMatch(text, /affects ([^\n*]+)/);
  const files = Array.from(text.matchAll(/^\*\*([^*]+):\*\*/gm)).map((match) => match[1]);
  return [
    count ? `impact: ${count.trim()}` : undefined,
    files.length > 0 ? `files: ${files.length} · ${files.slice(0, 3).join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function summarizeExplore(text: string): string[] {
  const found = /Found (\d+) symbols across (\d+) files/.exec(text);
  const blast = collectBulletEntries(getSection(text, "**Blast radius", "**Source Code**"), 20).length;
  return [
    found ? `found: ${found[1]} symbols · ${found[2]} files` : undefined,
    blast > 0 ? `blast radius: ${blast} dependents` : undefined,
    text.includes("**Source Code**") ? "source: included" : undefined,
  ].filter((line): line is string => Boolean(line));
}

function summarizeToolResult(tool: CodeGraphToolDefinition, args: ToolParams, text: string): string[] {
  switch (tool.name) {
    case "codegraph_status":
      return summarizeStatus(text);
    case "codegraph_files":
      return summarizeFiles(text, args);
    case "codegraph_search":
      return summarizeSearch(text);
    case "codegraph_node":
      return summarizeNode(text);
    case "codegraph_callers":
      return summarizeCallList(text, "callers");
    case "codegraph_callees":
      return summarizeCallList(text, "callees");
    case "codegraph_impact":
      return summarizeImpact(text);
    case "codegraph_explore":
      return summarizeExplore(text);
  }
}

function renderCodeGraphResult(
  tool: CodeGraphToolDefinition,
  result: ToolRenderResult | undefined,
  options: CodeGraphRenderOptions,
  theme: ToolTheme,
  context: CodeGraphRenderContext = {},
): Text {
  const text = getResultText(result);
  const args = context.args || {};
  const isError = Boolean(result?.isError || context.isError);
  const lineCount = countResultLines(text);
  const byteCount = Buffer.byteLength(text, "utf8");
  const status = isError ? "error" : options.isPartial ? "running" : undefined;

  if (options.expanded) {
    return new Text(text, 0, 0);
  }

  const paths = collectBacktickedPaths(text);
  const firstLine = getFirstMeaningfulLine(text);
  const projectPath = formatArgValue("projectPath", args.projectPath);
  const toolSummary = summarizeToolResult(tool, args, text);
  const details = [
    ...(status ? [status] : []),
    ...toolSummary,
    `output: ${lineCount} lines · ${formatBytes(byteCount)}`,
  ];

  if (paths.length > 0 && !toolSummary.some((line) => line.startsWith("files:"))) {
    details.push(`files: ${paths.length} · ${paths.slice(0, 3).join(", ")}`);
  }
  if (projectPath) {
    details.push(`project: ${projectPath}`);
  }
  if (firstLine && toolSummary.length === 0 && !parseMarkdownHeading(text)) {
    details.push(`${isError ? "error" : "top"}: ${stripMarkdown(firstLine)}`);
  }
  details.push(keyHint("app.tools.expand", "to expand full result"));

  const lines = prefixTreeLines(details).map((line) => styleMuted(theme, line));
  return new Text(lines.join("\n"), 0, 0);
}

function isUninitializedToolResult(result: any): boolean {
  return isCodeGraphUninitializedMessage(getToolResultText(result));
}

function formatCodeGraphColdStatus(project: ResolvedCodeGraphProject): string {
  return [
    `CodeGraph is enabled for ${project.cwd}, but the index is not built yet.`,
    "codegraph_status is inspect-only and did not run codegraph init.",
    `First non-status CodeGraph query will run: codegraph init ${project.cwd}`,
  ].join("\n");
}

function formatCodeGraphNoMarkerStatus(project: ResolvedCodeGraphProject): string {
  return [
    `CodeGraph is not enabled for ${project.cwd}.`,
    "No .codegraph marker was found at or above that directory.",
    "codegraph_status is inspect-only and did not create or initialize an index.",
  ].join("\n");
}

function formatCodeGraphNoMarkerToolResult(project: ResolvedCodeGraphProject): string {
  return [
    `CodeGraph is not enabled for ${project.cwd}.`,
    "No .codegraph marker was found at or above that directory, so this tool did not start CodeGraph.",
    "Use read/rg/fd for this codebase instead. To enable CodeGraph, run `codegraph init` from the intended project root, then retry.",
  ].join("\n");
}

async function requestCodeGraphTool(
  name: ToolName,
  args: ToolParams,
  project: ResolvedCodeGraphProject,
  signal: AbortSignal | undefined,
): Promise<any> {
  return withToolsCallTimeoutRetry(signal, () =>
    withCodeGraphMcp(
      project.cwd,
      signal,
      (request) =>
        request("tools/call", {
          name,
          arguments: args,
        }),
    ),
  );
}

async function callCodeGraphToolWithInitRetry(
  name: ToolName,
  args: ToolParams,
  project: ResolvedCodeGraphProject,
  signal: AbortSignal | undefined,
): Promise<any> {
  const shouldAutoInit = name !== "codegraph_status" && project.hasCodeGraphMarker;

  try {
    const result = await requestCodeGraphTool(name, args, project, signal);
    if (!shouldAutoInit || !isUninitializedToolResult(result)) return result;
  } catch (error) {
    if (!shouldAutoInit || !isCodeGraphUninitializedMessage(getErrorMessage(error))) throw error;
  }

  await initCodeGraphProject(project.cwd, signal);
  return requestCodeGraphTool(name, args, project, signal);
}

export async function callCodeGraphTool(
  name: ToolName,
  params: ToolParams,
  signal?: AbortSignal,
): Promise<string> {
  const { args, originalFilesPath } = await prepareToolArguments(name, params);

  const projectPath = typeof args.projectPath === "string" ? args.projectPath : undefined;
  const project = await resolveCodeGraphProject(projectPath);
  if (!project.hasCodeGraphMarker) {
    return name === "codegraph_status"
      ? formatCodeGraphNoMarkerStatus(project)
      : formatCodeGraphNoMarkerToolResult(project);
  }

  const mcpArgs = canonicalizeMcpToolArguments(args, project);

  let result;
  try {
    result = await enqueueCodeGraphRequest(project.cwd, () =>
      callCodeGraphToolWithInitRetry(name, mcpArgs, project, signal)
    );
  } catch (error) {
    if (name === "codegraph_status" && isCodeGraphUninitializedMessage(getErrorMessage(error))) {
      return formatCodeGraphColdStatus(project);
    }
    throw error;
  }

  const text = getToolResultText(result);

  if (name === "codegraph_status" && isCodeGraphUninitializedMessage(text)) {
    return formatCodeGraphColdStatus(project);
  }

  if (result?.isError) {
    throw new Error(text || "CodeGraph tool failed.");
  }
  const finalText = text || JSON.stringify(result);
  return name === "codegraph_files" ? annotateFilesResult(finalText, originalFilesPath) : finalText;
}

export function formatCodeGraphError(error: unknown, toolName: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes("enoent") || lower.includes("spawn codegraph")) {
    return [
      `CodeGraph ${toolName} failed: the \`codegraph\` CLI was not found on PATH.`,
      "Install it, then relaunch pi from the same shell:",
      "  npm install -g @colbymchenry/codegraph",
      "Or install it inside the project:",
      "  npm install -D @colbymchenry/codegraph",
    ].join("\n");
  }

  if (isCodeGraphUninitializedMessage(message)) {
    return [
      `CodeGraph ${toolName} failed: ${message}`,
      "Build the index in the project root first:",
      "  codegraph init <project-root>",
      "  codegraph status",
    ].join("\n");
  }

  return `CodeGraph ${toolName} failed: ${message}`;
}

export default function codegraphExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    // Only steer toward CodeGraph when the active project has a valid .codegraph project marker.
    // This hook fires once per user turn and ctx.cwd is read fresh each time, so a
    // marker created mid-session is picked up next turn.
    if (!findCodeGraphRoot(ctx.cwd)) return {};

    const guidance = [
      "For architecture, flow, where-is-symbol, impact, and codebase navigation questions, use CodeGraph (codegraph_* tools) directly before grep/read.",
      "First non-status CodeGraph query may initialize a cold worktree automatically if needed.",
      "Use codegraph_explore first for broad questions, codegraph_search for symbol-name lookup, codegraph_files for project structure, codegraph_node for a known symbol, and codegraph_callers/codegraph_impact for impact and flow analysis.",
      "If codegraph_search returns no exact result, try codegraph_explore or codegraph_files/codegraph_node before falling back to grep/read; symbol search may miss literal constants or generated names that still exist in source text.",
      "Do not re-verify a CodeGraph result with grep/read, and do not re-open files whose source codegraph_explore or codegraph_node already returned.",
      "Do not loop codegraph_node over many symbols — use codegraph_impact or codegraph_callers for breadth, and codegraph_explore to read several at once.",
      "Otherwise use grep/read only after CodeGraph is insufficient or when the user asks for literal text matching.",
    ].join("\n");

    return {
      systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${guidance}` : guidance,
    };
  });

  for (const tool of ToolDefinitions) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      renderCall(args: ToolParams, theme: ToolTheme) {
        return renderCodeGraphCall(tool, args || {}, theme);
      },
      renderResult(result: ToolRenderResult, options: CodeGraphRenderOptions, theme: ToolTheme, context: CodeGraphRenderContext) {
        return renderCodeGraphResult(tool, result, options || {}, theme, context);
      },
      async execute(_toolCallId, params: Static<typeof tool.parameters>, signal, _onUpdate, ctx) {
        const toolParams = (params || {}) as ToolParams;
        try {
          const text = await callCodeGraphTool(tool.name, { projectPath: ctx.cwd, ...toolParams }, signal);
          return {
            content: [{ type: "text" as const, text }],
            details: {},
          };
        } catch (error) {
          throw new Error(formatCodeGraphError(error, tool.name));
        }
      },
    });
  }
}
