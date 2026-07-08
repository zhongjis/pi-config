/**
 * Orchestrates a parsed github path into a materialized markdown file path.
 *
 * Flow: derive host+repo (explicit → cwd git remote → github.com) → resolve an
 * account with access → cache lookup (account-scoped key) → on miss, fetch via
 * gh, render, and cache. Returns the on-disk `.md` path the built-in `read`
 * tool then pages.
 *
 * All external effects arrive through {@link ResolveDeps} so the orchestrator
 * is unit-testable with fakes and never touches the network in tests.
 */

import type { AuthResolver, GhRunner } from "./gh.js";
import { ghContents, ghList, ghPrDiff, ghViewSingle } from "./gh.js";
import type { GithubCache } from "./cache.js";
import { isTerminalState } from "./cache.js";
import { renderContentStub, renderDiff, renderList, renderSingle, renderTree } from "./render.js";
import type { ParsedGithubTarget, RepoRef } from "./parse.js";

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
  /** Return the origin remote URL for a cwd, or null when not a git repo. */
  gitRemoteUrl: (cwd: string) => Promise<string | null>;
  /** Canonicalize an SSH host alias to its real hostname (e.g. via `ssh -G`). */
  resolveHostAlias: (host: string) => Promise<string>;
}

async function resolveHostAndRepo(
  cwd: string,
  target: ParsedGithubTarget,
  deps: ResolveDeps,
): Promise<{ host: string; repo: RepoRef }> {
  let remote: RemoteRef | null = null;
  if (!target.host || !target.repo) {
    const url = await deps.gitRemoteUrl(cwd);
    remote = url ? parseRemoteUrl(url) : null;
    // An SSH remote host may be a ~/.ssh/config alias (e.g. github.com-work);
    // resolve it to the real hostname so auth + gh target the right host.
    if (remote?.ssh) {
      remote = { ...remote, host: await deps.resolveHostAlias(remote.host) };
    }
  }

  const host = target.host ?? remote?.host ?? GITHUB_DOT_COM;

  if (target.repo) return { host, repo: target.repo };
  if (remote) return { host, repo: { owner: remote.owner, repo: remote.repo } };

  throw new Error(
    `Cannot determine a repository for '${target.input}'. Run from inside a git checkout with an 'origin' remote, or use a fully-qualified path like ${target.scheme}://owner/repo/<number>.`,
  );
}

function deriveExt(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m && m[1].length <= 12 ? `.${m[1].toLowerCase()}` : ".txt";
}

function contentShape(target: ParsedGithubTarget): Record<string, unknown> {
  switch (target.kind) {
    case "single":
      return { kind: "single", number: target.number, comments: target.comments };
    case "list":
      return {
        kind: "list",
        state: target.state,
        limit: target.limit,
        author: target.author ?? null,
        label: target.label ?? null,
      };
    case "diff":
      return { kind: "diff", number: target.number, mode: target.mode, index: target.index ?? null };
    case "content":
      return { kind: "content", path: target.path, ref: target.ref ?? null };
  }
}

async function fetchAndRender(
  deps: ResolveDeps,
  token: string,
  host: string,
  repo: RepoRef,
  target: ParsedGithubTarget,
): Promise<{ markdown: string; terminal: boolean; ext: string }> {
  const shared = { host, owner: repo.owner, repo: repo.repo, token };

  if (target.kind === "single") {
    const json = await ghViewSingle(deps.run, target.scheme, {
      ...shared,
      number: target.number,
      comments: target.comments,
    });
    return {
      markdown: renderSingle(target.scheme, json, repo),
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
    return { markdown: renderList(target.scheme, items, repo, target.state), terminal: false, ext: ".md" };
  }

  if (target.kind === "content") {
    const res = await ghContents(deps.run, { ...shared, path: target.path, ref: target.ref });
    const terminal = /^[0-9a-f]{40}$/i.test(target.ref ?? "");
    if (res.kind === "dir") return { markdown: renderTree(res.entries, repo, target.path, target.ref), terminal, ext: ".md" };
    if (res.kind === "file") return { markdown: res.text, terminal, ext: deriveExt(res.name) };
    return { markdown: renderContentStub(res, repo, target.ref), terminal, ext: ".md" };
  }

  // diff (pr only)
  const diff = await ghPrDiff(deps.run, { ...shared, number: target.number });
  return { markdown: renderDiff(diff, target.number, target.mode, target.index), terminal: false, ext: ".md" };
}

/** Resolve a parsed target to a materialized `.md` path. */
export async function resolveGithubView(cwd: string, target: ParsedGithubTarget, deps: ResolveDeps): Promise<string> {
  const { host, repo } = await resolveHostAndRepo(cwd, target, deps);
  const account = await deps.auth.resolve(host, repo.owner, repo.repo);

  const key = deps.cache.key({
    host,
    account: account.user,
    owner: repo.owner,
    repo: repo.repo,
    scheme: target.scheme,
    ...contentShape(target),
  });

  const hit = await deps.cache.get(key, { refresh: target.refresh });
  if (hit) return hit;

  const { markdown, terminal, ext } = await fetchAndRender(deps, account.token, host, repo, target);
  return deps.cache.put(key, markdown, { terminal, ext });
}
