/**
 * Orchestrates a parsed github path into a materialized file path.
 *
 * Flow: resolve host+repo → resolve an
 * account with access → cache lookup (account-scoped key) → on miss, fetch via
 * gh, render, and cache. Returns the on-disk file path the built-in `read`
 * tool then pages.
 *
 * All external effects arrive through {@link ResolveDeps} so the orchestrator
 * is unit-testable with fakes and never touches the network in tests.
 */

import type { AuthResolver, GhRunner } from "./gh.js";
import { ghContents, ghList, ghPrDiff, ghReviewThreads, ghViewSingle } from "./gh.js";
import type { GithubCache } from "./cache.js";
import { isTerminalState } from "./cache.js";
import { renderContentStub, renderList, renderSingle, renderTree } from "./render.js";
import { renderDiff } from "./render-diff.js";
import type { ParsedGithubTarget, RepoRef } from "./parse.js";

declare function require(id: string): unknown;

const { readFile } = require("node:fs/promises") as {
  readFile: (path: string, encoding: string) => Promise<string>;
};

const GITHUB_DOT_COM = "github.com";

export interface RemoteRef {
  host: string;
  owner: string;
  repo: string;
  /** True when parsed from an SSH remote, whose host may be a ~/.ssh/config alias. */
  ssh: boolean;
}

/** Parse a git remote URL (scp-like or scheme URL) into host/owner/repo. */
export function parseRemoteUrl(url: string): RemoteRef | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp) return splitOwnerRepo(scp[1], scp[2], true);

  const scheme = /^([a-z]+):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scheme) return splitOwnerRepo(scheme[2], scheme[3], scheme[1] === "ssh");

  return null;
}

function splitOwnerRepo(host: string, path: string, ssh: boolean): RemoteRef | null {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  return { host, owner: parts[parts.length - 2], repo: parts[parts.length - 1], ssh };
}

export interface ResolveDeps {
  run: GhRunner;
  auth: AuthResolver;
  cache: GithubCache;
  /** Return the cwd origin remote with SSH aliases canonicalized, or null when not a git repo. */
  remote: (cwd: string) => Promise<RemoteRef | null>;
}

/** Memoize origin parsing and SSH alias canonicalization within an extension instance. */
export function createRemoteResolver(
  gitRemoteUrl: (cwd: string) => Promise<string | null>,
  resolveHostAlias: (host: string) => Promise<string>,
): (cwd: string) => Promise<RemoteRef | null> {
  const memo = new Map<string, Promise<RemoteRef | null>>();
  return (cwd) => {
    let pending = memo.get(cwd);
    if (!pending) {
      pending = (async () => {
        const url = await gitRemoteUrl(cwd);
        const remote = url ? parseRemoteUrl(url) : null;
        return remote?.ssh ? { ...remote, host: await resolveHostAlias(remote.host) } : remote;
      })();
      memo.set(cwd, pending);
    }
    return pending;
  };
}

async function resolveHostAndRepo(
  cwd: string,
  target: ParsedGithubTarget,
  deps: ResolveDeps,
): Promise<{ host: string; repo: RepoRef }> {
  const remote = target.host && target.repo ? null : await deps.remote(cwd);
  const matchesRemote = target.repo && remote &&
    target.repo.owner.toLowerCase() === remote.owner.toLowerCase() &&
    target.repo.repo.toLowerCase() === remote.repo.toLowerCase();
  const host = target.host ?? (target.repo && !matchesRemote ? GITHUB_DOT_COM : remote?.host ?? GITHUB_DOT_COM);
  if (target.repo) return { host, repo: target.repo };
  if (remote) return { host, repo: { owner: remote.owner, repo: remote.repo } };
  throw new Error(
    `Cannot determine a repository for '${target.input}'. Run from inside a git checkout with an 'origin' remote, or use ${target.scheme === "pr" ? "gh-pr" : "gh-issue"}://[host/]owner/repo/<number>.`,
  );
}

function deriveExt(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m && m[1].length <= 12 ? `.${m[1].toLowerCase()}` : ".txt";
}

function contentShape(target: ParsedGithubTarget): Record<string, unknown> {
  switch (target.kind) {
    case "single":
      return { kind: "single", number: target.number };
    case "list":
      return {
        kind: "list",
        state: target.state,
        limit: target.limit,
        author: target.author ?? null,
        label: target.label ?? null,
      };
    case "diff":
      return { kind: "diff", number: target.number, mode: target.mode, path: target.path ?? null };
    case "content":
      return { kind: "content", path: target.path, ref: target.ref ?? null };
  }
}

async function fetchAndRender(
  deps: ResolveDeps,
  token: string,
  host: string,
  repo: RepoRef,
  target: Exclude<ParsedGithubTarget, { kind: "diff" }>,
  signal?: AbortSignal,
): Promise<{ markdown: string; terminal: boolean; ext: string }> {
  const shared = { host, owner: repo.owner, repo: repo.repo, token, signal };

  if (target.kind === "single") {
    const json = await ghViewSingle(deps.run, target.scheme, {
      ...shared,
      number: target.number,
    });
    return {
      markdown: renderSingle(target.scheme, json, { host, repo }, target.scheme === "pr"
        ? await ghReviewThreads(deps.run, { ...shared, number: target.number }) : undefined),
      terminal: isTerminalState(typeof json.state === "string" ? json.state : undefined),
      ext: ".md",
    };
  }

  if (target.kind === "list") {
    const items = await ghList(deps.run, target.scheme, {
      ...shared,
      state: target.state,
      limit: target.limit,
      author: target.author,
      label: target.label,
    });
    return { markdown: renderList(target.scheme, items, { host, repo }, target.state), terminal: false, ext: ".md" };
  }

  const res = await ghContents(deps.run, { ...shared, path: target.path, ref: target.ref });
  const terminal = /^[0-9a-f]{40}$/i.test(target.ref ?? "");
  if (res.kind === "dir") return { markdown: renderTree(res.entries, { host, repo }, target.path, target.ref), terminal, ext: ".md" };
  if (res.kind === "file") return { markdown: res.text, terminal, ext: deriveExt(res.name) };
  return { markdown: renderContentStub(res, repo, target.ref), terminal, ext: ".md" };
}

// Coalesce parallel diff views within each extension cache instance; disk cache owns freshness.
const diffFetches = new WeakMap<GithubCache, Map<string, Promise<string>>>();

async function cachedRawDiff(
  deps: ResolveDeps,
  key: string,
  args: Parameters<typeof ghPrDiff>[1],
  refresh: boolean,
): Promise<string> {
  let pending = diffFetches.get(deps.cache);
  if (!pending) {
    pending = new Map();
    diffFetches.set(deps.cache, pending);
  }
  let fetch = pending.get(key);
  if (!fetch) {
    fetch = (async () => {
      const hit = await deps.cache.get(key, { refresh });
      if (hit) return readFile(hit, "utf8");
      const diff = await ghPrDiff(deps.run, args);
      await deps.cache.put(key, diff, { terminal: false, ext: ".diff" });
      return diff;
    })();
    pending.set(key, fetch);
  }
  try {
    return await fetch;
  } finally {
    pending.delete(key);
  }
}

/** Resolve a parsed target to a materialized file path. */
export async function resolveGithubView(cwd: string, target: ParsedGithubTarget, deps: ResolveDeps, signal?: AbortSignal): Promise<string> {
  const { host, repo } = await resolveHostAndRepo(cwd, target, deps);
  const account = await deps.auth.resolve(host, repo.owner, repo.repo, signal);

  const identity = {
    host,
    account: account.user,
    owner: repo.owner,
    repo: repo.repo,
    scheme: target.scheme,
  };
  const key = deps.cache.key({ ...identity, ...contentShape(target) });

  if (target.kind === "diff") {
    const rawKey = deps.cache.key({ ...identity, kind: "raw-diff", number: target.number });
    const diff = await cachedRawDiff(deps, rawKey, { host, owner: repo.owner, repo: repo.repo,
      number: target.number, token: account.token, signal }, target.refresh);
    return deps.cache.put(key, renderDiff(diff, target.number, target.mode, target.path, { host, repo }), { terminal: false });
  }

  const hit = await deps.cache.get(key, { refresh: target.refresh });
  if (hit) return hit;

  const { markdown, terminal, ext } = await fetchAndRender(deps, account.token, host, repo, target, signal);
  return deps.cache.put(key, markdown, { terminal, ext });
}
