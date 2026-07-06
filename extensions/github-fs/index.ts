/**
 * github-fs — read GitHub issues, PRs, and diffs as `read` paths.
 *
 * Mirrors the session-local pattern: a `tool_call` hook rewrites `pr://` /
 * `issue://` paths to a materialized cache file so the built-in `read` tool
 * pages them like any file; a `tool_result` hook rewrites the cache path back
 * to the original virtual path. Read-only — `write`/`edit` on these paths are
 * blocked. See README.md for the path grammar.
 */

declare function require(id: string): any;

const { spawn } = require("node:child_process") as {
  spawn: (command: string, args: string[], options: Record<string, unknown>) => GitChildProcess;
};

interface GitChildProcess {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: (code: number | null) => void): void;
}

import { createCache } from "./cache.js";
import { createAuthResolver, createGhRunner } from "./gh.js";
import { isGithubPath, parseGithubPath } from "./parse.js";
import { type ResolveDeps, resolveGithubView } from "./resolve.js";

interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolExecutionEndEvent {
  toolCallId: string;
}

interface ToolResultBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface ToolResultEvent {
  toolCallId: string;
  content: ToolResultBlock[];
  details?: Record<string, unknown>;
}

interface BeforeAgentStartEvent {
  systemPrompt?: string;
}

interface GithubFsContext {
  cwd: string;
}

interface ExtensionAPI {
  on(event: string, handler: (event: unknown, ctx: GithubFsContext) => unknown | Promise<unknown>): void;
}

interface Resolution {
  input: string;
  resolvedPath: string;
}

const GITHUB_FS_TOOL_NAMES = new Set(["read", "write", "edit"]);

const PROMPT_GUIDE = [
  "",
  "",
  "## GitHub virtual paths (github-fs)",
  "Read GitHub issues and pull requests as paths with the `read` tool — no separate GitHub tool:",
  "- `issue://<n>` / `pr://<n>` — single item in the current repo (repo + host derived from the git remote)",
  "- `issue://owner/repo/<n>` / `pr://owner/repo/<n>` — fully qualified",
  "- `issue://` / `pr://` (optionally `owner/repo`) — list recent items; filter with `?state=`, `?limit=`, `?author=`, `?label=`",
  "- `pr://<n>/diff` (file list), `pr://<n>/diff/all` (full diff), `pr://<n>/diff/<i>` (one file, 1-based)",
  "- Query flags: `?comments=0` (hide comments), `?host=<ghe-host>`, `?refresh=1` (bypass cache)",
  "These are read-only views; use the gh CLI to create or modify. Page large diffs/lists with read's offset/limit.",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequestedPath(input: Record<string, unknown>): string | undefined {
  const value = input.path;
  return typeof value === "string" ? value : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rewriteText(text: string, resolution: Resolution): string {
  return text.split(resolution.resolvedPath).join(resolution.input);
}

function rewriteContent(content: ToolResultBlock[], resolution: Resolution): ToolResultBlock[] {
  return content.map((block) =>
    block.type === "text" && typeof block.text === "string"
      ? { ...block, text: rewriteText(block.text, resolution) }
      : block,
  );
}

function rewriteDetails(
  details: Record<string, unknown> | undefined,
  resolution: Resolution,
): Record<string, unknown> {
  const source = isRecord(details) ? details : {};
  const next: Record<string, unknown> = {};
  for (const [detailKey, value] of Object.entries(source)) {
    next[detailKey] = typeof value === "string" ? rewriteText(value, resolution) : value;
  }
  // Present the virtual path as the canonical path; keep the backing file for debugging.
  next.path = resolution.input;
  next.backingPath = resolution.resolvedPath;
  return next;
}

// Canonicalize an SSH host alias (e.g. `github.com-work`) to its real hostname
// via `ssh -G`. Falls back to the alias unchanged if ssh is unavailable or the
// host has no `hostname` override.
function createResolveHostAlias(): (host: string) => Promise<string> {
  return (host) =>
    new Promise<string>((resolvePromise) => {
      let stdout = "";
      const child = spawn("ssh", ["-G", host], {});
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("error", () => resolvePromise(host));
      child.on("close", (code) => {
        if (code !== 0) return resolvePromise(host);
        const match = /^hostname\s+(\S+)/im.exec(stdout);
        resolvePromise(match ? match[1] : host);
      });
    });
}

function createGitRemoteUrl(): (cwd: string) => Promise<string | null> {
  return (cwd) =>
    new Promise<string | null>((resolvePromise) => {
      let stdout = "";
      const child = spawn("git", ["-C", cwd, "remote", "get-url", "origin"], {});
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("error", () => resolvePromise(null));
      child.on("close", (code) => resolvePromise(code === 0 && stdout.trim() ? stdout.trim() : null));
    });
}

export default function githubFsTools(pi: ExtensionAPI): void {
  const resolutions = new Map<string, Resolution>();

  const run = createGhRunner();
  const deps: ResolveDeps = {
    run,
    auth: createAuthResolver(run),
    cache: createCache(),
    gitRemoteUrl: createGitRemoteUrl(),
    resolveHostAlias: createResolveHostAlias(),
  };

  pi.on("tool_call", async (rawEvent, ctx) => {
    const event = rawEvent as ToolCallEvent | null;
    if (!event || typeof event.toolCallId !== "string") return undefined;
    if (!GITHUB_FS_TOOL_NAMES.has(event.toolName)) return undefined;
    if (!isRecord(event.input)) return undefined;

    const requestedPath = getRequestedPath(event.input);
    if (!requestedPath || !isGithubPath(requestedPath)) return undefined;

    if (event.toolName !== "read") {
      return {
        block: true,
        reason: `${event.toolName} cannot modify ${requestedPath}. github-fs paths (pr://, issue://) are read-only views — use the gh CLI to create or change issues/PRs.`,
      };
    }

    let target;
    try {
      target = parseGithubPath(requestedPath);
    } catch (error) {
      return { block: true, reason: describeError(error) };
    }
    if (!target) return undefined;

    let resolvedPath: string;
    try {
      resolvedPath = await resolveGithubView(ctx.cwd, target, deps);
    } catch (error) {
      return { block: true, reason: `Could not read ${requestedPath}: ${describeError(error)}` };
    }

    event.input.path = resolvedPath;
    resolutions.set(event.toolCallId, { input: requestedPath, resolvedPath });
    return undefined;
  });

  pi.on("tool_result", async (rawEvent) => {
    const event = rawEvent as ToolResultEvent | null;
    if (!event || typeof event.toolCallId !== "string") return undefined;
    const resolution = resolutions.get(event.toolCallId);
    if (!resolution) return undefined;
    resolutions.delete(event.toolCallId);
    return {
      content: rewriteContent(event.content, resolution),
      details: rewriteDetails(event.details, resolution),
    };
  });

  pi.on("tool_execution_end", async (rawEvent) => {
    const event = rawEvent as ToolExecutionEndEvent | null;
    if (!event || typeof event.toolCallId !== "string") return undefined;
    resolutions.delete(event.toolCallId);
    return undefined;
  });

  // Insurance against a leaked Map entry when a later hook blocks the call.
  pi.on("session_start", async () => {
    resolutions.clear();
    return undefined;
  });

  // Teach the model the path grammar (part of the cacheable system prompt).
  pi.on("before_agent_start", async (rawEvent) => {
    const event = rawEvent as BeforeAgentStartEvent | null;
    if (!event || typeof event.systemPrompt !== "string") return undefined;
    return { systemPrompt: event.systemPrompt + PROMPT_GUIDE };
  });
}
