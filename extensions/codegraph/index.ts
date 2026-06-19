import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
    description: "Get CodeGraph index status.",
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

const MaxDiagnosticLength = 1000;
const projectQueues = new Map<string, Promise<void>>();
const RequestTimeoutMs = Number(process.env.CODEGRAPH_TIMEOUT_MS) || 30_000;

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

export async function withCodeGraphMcp<T>(
  projectPath: string | undefined,
  signal: AbortSignal | undefined,
  fn: (request: JsonRpcRequest) => Promise<T>,
): Promise<T> {
  const cwd = await resolveProjectCwd(projectPath);
  const child = spawn("codegraph", ["serve", "--mcp", "--path", cwd], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return runJsonRpcSession(child, cwd, signal, fn);
}

function findCodeGraphRoot(startDir: string): string | undefined {
  let current = startDir;
  let parent = path.dirname(current);
  while (current !== parent) {
    if (existsSync(path.join(current, ".codegraph"))) return current;
    current = parent;
    parent = path.dirname(current);
  }
  return existsSync(path.join(current, ".codegraph")) ? current : undefined;
}

export async function resolveProjectCwd(projectPath: string | undefined): Promise<string> {
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

  return findCodeGraphRoot(cwd) ?? cwd;
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
  const projectCwd = await resolveProjectCwd(projectPath);
  const originalFilesPath = typeof params.path === "string" ? params.path : undefined;
  const normalizedPath = normalizeFilesPath(originalFilesPath, projectCwd);

  const args: ToolParams = { ...params };
  if (normalizedPath === undefined) {
    delete args.path;
  } else {
    args.path = normalizedPath;
  }

  return { args, originalFilesPath };
}

export async function callCodeGraphTool(
  name: ToolName,
  params: ToolParams,
  signal?: AbortSignal,
): Promise<string> {
  const { args, originalFilesPath } = await prepareToolArguments(name, params);

  const projectPath = typeof args.projectPath === "string" ? args.projectPath : undefined;
  const projectCwd = await resolveProjectCwd(projectPath);
  const result = await enqueueCodeGraphRequest(projectCwd, () =>
    withCodeGraphMcp(
      projectCwd,
      signal,
      (request) =>
        request("tools/call", {
          name,
          arguments: args,
        }),
    )
  );

  const text = (result?.content || [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");

  if (result?.isError) throw new Error(text || "CodeGraph tool failed.");
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

  if (lower.includes("not initialized") || lower.includes(".codegraph")) {
    return [
      `CodeGraph ${toolName} failed: ${message}`,
      "Build the index in the project root first:",
      "  codegraph init -i",
      "  codegraph status",
    ].join("\n");
  }

  return `CodeGraph ${toolName} failed: ${message}`;
}

export default function codegraphExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    // Only steer toward CodeGraph when the active project actually has an index.
    // This hook fires once per user turn and ctx.cwd is read fresh each time, so an
    // index created mid-session (e.g. `codegraph init -i`) is picked up next turn.
    if (!findCodeGraphRoot(ctx.cwd)) return {};

    const guidance = [
      "For architecture, flow, where-is-symbol, impact, and codebase navigation questions, use CodeGraph (codegraph_* tools) directly before grep/read.",
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
