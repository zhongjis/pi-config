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

const GITHUB_SELECTOR_RE = /(:(?:raw|conflicts|\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*(?::raw)?|raw:\d+(?:[-+]\d+)?))$/;

const PROMPT_GUIDE = [
  "",
  "",
  "## GitHub virtual paths (github-fs)",
  "Read GitHub issues and pull requests as paths with the `read` tool — no separate GitHub tool:",
  "- `issue://<n>` / `pr://<n>` — single item in the current repo (repo + host derived from the git remote)",
  "- `issue://owner/repo/<n>` / `pr://owner/repo/<n>` — fully qualified",
  "- `issue://` / `pr://` (optionally `owner/repo`) — list recent items; filter with `?state=`, `?limit=`, `?author=`, `?label=`",
  "- `pr://<n>/diff` (file list), `pr://<n>/diff/all` (full diff), `pr://<n>/diff/<i>` (one file, 1-based)",
  "- `github://owner/repo/path/to/file` — a repo file's contents; `github://owner/repo/path/to/dir` — one-level directory listing; `github://owner/repo` — repo root",
  "- `?ref=<branch|tag|sha>` pins a version (default branch otherwise); line ranges work: `github://owner/repo/file.ts:20-60`",
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

function splitGithubSelector(path: string): { base: string; selector: string } {
  if (!path.startsWith("github://")) return { base: path, selector: "" };
  const m = GITHUB_SELECTOR_RE.exec(path);
  if (!m) return { base: path, selector: "" };
  return { base: path.slice(0, m.index), selector: m[1] };
}

// A materialized github:// cache file is a real file the read tool pages via
// offset/limit — not a `:range` path suffix. Map a simple numeric selector to
// offset/limit; return null for raw/conflicts/multi-range (whole-file read).
function selectorToRange(selector: string): { offset: number; limit?: number } | null {
  const m = /^:(\d+)(?:-(\d+)|\+(\d+))?$/.exec(selector);
  if (!m) return null;
  const start = Number(m[1]);
  if (m[2]) return { offset: start, limit: Math.max(1, Number(m[2]) - start + 1) };
  if (m[3]) return { offset: start, limit: Number(m[3]) };
  return { offset: start };
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
        reason: `${event.toolName} cannot modify ${requestedPath}. github-fs paths (pr://, issue://, github://) are read-only views — use the gh CLI to create or change issues/PRs, or clone the repo to edit files.`,
      };
    }

    const { base, selector } = splitGithubSelector(requestedPath);

    let target;
    try {
      target = parseGithubPath(base);
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
    // The cache file is a real file read pages via offset/limit, not a `:range`
    // path suffix. Translate a simple numeric selector unless the harness already
    // derived a window; leave raw/conflicts/multi-range to a whole-file read.
    const range = selector ? selectorToRange(selector) : null;
    if (range && event.input.offset === undefined && event.input.limit === undefined) {
      event.input.offset = range.offset;
      if (range.limit !== undefined) event.input.limit = range.limit;
    }
    resolutions.set(event.toolCallId, { input: base, resolvedPath });
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
