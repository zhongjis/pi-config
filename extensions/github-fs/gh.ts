/**
 * `gh` CLI access layer for github-fs.
 *
 * Two concerns live here behind a small interface:
 *   1. A {@link GhRunner} — the only thing that spawns `gh`. Injectable so
 *      tests substitute a fake and never touch the network.
 *   2. Multi-account auth — enumerate logged-in accounts, resolve which one can
 *      see a given repo, and inject that account's token per invocation.
 *
 * Security invariants (do not regress):
 *   - Tokens flow ONLY through per-spawn env. Never log env/argv, never put a
 *     token in an Error message, cache file, tool result, or `details`.
 *   - Account identity does not cross a trust boundary here (one OS user, one
 *     process); resolving the right account is a correctness control, not a
 *     security one.
 */

declare function require(id: string): any;

const { spawn } = require("node:child_process") as {
  spawn: (
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined> },
  ) => ChildProcessLike;
};

interface ChildProcessLike {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: (code: number | null) => void): void;
  kill(signal?: string): void;
}

export interface GhRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GhRunOptions {
  args: string[];
  /** Target host; selects which token env var is set. */
  host?: string;
  /** Account token; injected into env only, never logged. */
  token?: string;
  cwd?: string;
  signal?: AbortSignal;
}

export type GhRunner = (options: GhRunOptions) => Promise<GhRunResult>;

const GITHUB_DOT_COM = "github.com";

/** Build the env overrides for a token+host without mutating global gh state. */
function tokenEnv(host: string | undefined, token: string | undefined): Record<string, string> {
  if (!token) return {};
  if (!host || host === GITHUB_DOT_COM) {
    return { GH_TOKEN: token };
  }
  return { GH_ENTERPRISE_TOKEN: token, GH_HOST: host };
}

/** Real runner: spawns `gh`, captures output. Never logs command/env. */
export function createGhRunner(): GhRunner {
  return ({ args, host, token, cwd, signal }) =>
    new Promise<GhRunResult>((resolvePromise, reject) => {
      const child = spawn("gh", args, {
        cwd,
        env: { ...process.env, ...tokenEnv(host, token) },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const onAbort = () => child.kill("SIGTERM");
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (err) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        // Surface a clean message; do not leak args/env.
        reject(new Error(`Failed to run gh: ${err.message}. Is the GitHub CLI installed?`));
      });
      child.on("close", (code) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolvePromise({ code: code ?? -1, stdout, stderr });
      });
    });
}

export interface GhAccount {
  host: string;
  user: string;
  active: boolean;
}

// Matches the two `gh auth status` per-account lines, valid and invalid:
//   "  ✓ Logged in to github.com account zhongjis (keyring)"
//   "  X Failed to log in to git.corp.adobe.com account zshen (keyring)"
const ACCOUNT_LINE = /^\s*(✓|x)\s+(?:Logged in to|Failed to log in to)\s+(\S+)\s+account\s+(\S+)/i;
const ACTIVE_LINE = /^\s*-\s+Active account:\s+true/i;

/**
 * Parse `gh auth status` output into the set of accounts whose tokens are
 * currently valid. Invalid/expired accounts are dropped — probing with them
 * only wastes a round-trip. `gh` prints status to stderr on some versions, so
 * both streams are scanned.
 */
export function parseAuthStatus(output: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  let current: GhAccount | undefined;
  for (const line of output.split("\n")) {
    const match = ACCOUNT_LINE.exec(line);
    if (match) {
      const valid = match[1] === "✓";
      current = { host: match[2], user: match[3], active: false };
      if (valid) accounts.push(current);
      else current = undefined; // subsequent Active line belongs to a dropped account
      continue;
    }
    if (current && ACTIVE_LINE.test(line)) {
      current.active = true;
    }
  }
  return accounts;
}

export async function listAccounts(run: GhRunner, signal?: AbortSignal): Promise<GhAccount[]> {
  const result = await run({ args: ["auth", "status"], signal });
  return parseAuthStatus(`${result.stdout}\n${result.stderr}`);
}

async function getToken(run: GhRunner, host: string, user: string, signal?: AbortSignal): Promise<string> {
  const result = await run({ args: ["auth", "token", "--hostname", host, "--user", user], signal });
  const token = result.stdout.trim();
  if (result.code !== 0 || !token) {
    // Never echo the token or stderr (may contain it in some gh versions).
    throw new Error(`Could not read gh token for account '${user}' on ${host}.`);
  }
  return token;
}

export interface ResolvedAccount {
  user: string;
  token: string;
}

export interface AuthResolver {
  /** Return an account that can read owner/repo on host, or throw. Memoized. */
  resolve(host: string, owner: string, repo: string, signal?: AbortSignal): Promise<ResolvedAccount>;
}

/**
 * Resolves repo access by probing candidate accounts in order (active first),
 * memoizing the winner per `host/owner/repo`. The account enumeration is cached
 * but re-run once when a host has no candidates, so a `gh auth login/refresh`
 * performed mid-session is picked up.
 */
export function createAuthResolver(run: GhRunner): AuthResolver {
  const repoMemo = new Map<string, ResolvedAccount>();
  let accountsPromise: Promise<GhAccount[]> | undefined;

  const getAccounts = (signal?: AbortSignal, force = false): Promise<GhAccount[]> => {
    if (force || !accountsPromise) accountsPromise = listAccounts(run, signal);
    return accountsPromise;
  };

  const candidatesFor = (accounts: GhAccount[], host: string): GhAccount[] =>
    accounts
      .filter((account) => account.host === host)
      .sort((left, right) => Number(right.active) - Number(left.active));

  return {
    async resolve(host, owner, repo, signal) {
      const key = `${host}/${owner}/${repo}`;
      const cached = repoMemo.get(key);
      if (cached) return cached;

      let candidates = candidatesFor(await getAccounts(signal), host);
      if (candidates.length === 0) {
        // The cached enumeration may predate a `gh auth login/refresh` for this
        // host (e.g. re-auth mid-session). Re-enumerate once before giving up.
        candidates = candidatesFor(await getAccounts(signal, true), host);
      }

      if (candidates.length === 0) {
        throw new Error(
          `No gh account is logged in to ${host}. Run: gh auth login --hostname ${host}`,
        );
      }

      const tried: string[] = [];
      for (const account of candidates) {
        const token = await getToken(run, host, account.user, signal);
        const probe = await run({
          args: ["api", `repos/${owner}/${repo}`, "--hostname", host, "-q", ".full_name"],
          host,
          token,
          signal,
        });
        if (probe.code === 0) {
          const resolved: ResolvedAccount = { user: account.user, token };
          repoMemo.set(key, resolved);
          return resolved;
        }
        tried.push(account.user);
      }

      throw new Error(
        `No authenticated gh account can access ${owner}/${repo} on ${host}. Tried: ${tried.join(", ")}.`,
      );
    },
  };
}

// --- Conservative --json field sets (avoid GHES field drift) -----------------

const ISSUE_VIEW_FIELDS = "number,title,state,author,labels,body,comments,createdAt,updatedAt,url";
const ISSUE_VIEW_FIELDS_NO_COMMENTS = "number,title,state,author,labels,body,createdAt,updatedAt,url";
const PR_VIEW_FIELDS =
  "number,title,state,author,labels,body,comments,createdAt,updatedAt,url,baseRefName,headRefName,isDraft,additions,deletions,mergedAt";
const PR_VIEW_FIELDS_NO_COMMENTS =
  "number,title,state,author,labels,body,createdAt,updatedAt,url,baseRefName,headRefName,isDraft,additions,deletions,mergedAt";
const ISSUE_LIST_FIELDS = "number,title,state,author,labels,updatedAt";
const PR_LIST_FIELDS = "number,title,state,author,labels,updatedAt,isDraft";

export type GithubScheme = "pr" | "issue";

function repoFlag(host: string, owner: string, repo: string): string {
  return `${host}/${owner}/${repo}`;
}

/** JSON-decode gh stdout, or throw with the gh stderr surfaced (no token). */
function parseJson<T>(result: GhRunResult, action: string): T {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`gh ${action} failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`gh ${action} returned unparseable JSON.`);
  }
}

export async function ghViewSingle(
  run: GhRunner,
  scheme: GithubScheme,
  args: { host: string; owner: string; repo: string; number: number; comments: boolean; token: string; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const fields =
    scheme === "pr"
      ? args.comments
        ? PR_VIEW_FIELDS
        : PR_VIEW_FIELDS_NO_COMMENTS
      : args.comments
        ? ISSUE_VIEW_FIELDS
        : ISSUE_VIEW_FIELDS_NO_COMMENTS;
  const result = await run({
    args: [scheme, "view", String(args.number), "-R", repoFlag(args.host, args.owner, args.repo), "--json", fields],
    host: args.host,
    token: args.token,
    signal: args.signal,
  });
  return parseJson<Record<string, unknown>>(result, `${scheme} view`);
}

export async function ghList(
  run: GhRunner,
  scheme: GithubScheme,
  args: {
    host: string;
    owner: string;
    repo: string;
    state: string;
    limit: number;
    author?: string;
    label?: string;
    token: string;
    signal?: AbortSignal;
  },
): Promise<Array<Record<string, unknown>>> {
  const fields = scheme === "pr" ? PR_LIST_FIELDS : ISSUE_LIST_FIELDS;
  const cmd = [
    scheme,
    "list",
    "-R",
    repoFlag(args.host, args.owner, args.repo),
    "--state",
    args.state,
    "--limit",
    String(args.limit),
    "--json",
    fields,
  ];
  if (args.author) cmd.push("--author", args.author);
  if (args.label) cmd.push("--label", args.label);
  const result = await run({ args: cmd, host: args.host, token: args.token, signal: args.signal });
  return parseJson<Array<Record<string, unknown>>>(result, `${scheme} list`);
}

export async function ghPrDiff(
  run: GhRunner,
  args: { host: string; owner: string; repo: string; number: number; token: string; signal?: AbortSignal },
): Promise<string> {
  const result = await run({
    args: ["pr", "diff", String(args.number), "-R", repoFlag(args.host, args.owner, args.repo)],
    host: args.host,
    token: args.token,
    signal: args.signal,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh pr diff failed: ${detail}`);
  }
  return result.stdout;
}
