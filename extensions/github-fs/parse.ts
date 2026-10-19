/** Pure parser for read-only gh://, gh-pr://, and gh-issue:// paths. */
export type GithubScheme = "pr" | "issue";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface CommonFields {
  scheme: GithubScheme;
  /** Explicit host prefix. */
  host?: string;
  /** Undefined means the cwd origin repository. */
  repo?: RepoRef;
  refresh: boolean;
  input: string;
}

export interface SingleTarget extends CommonFields {
  kind: "single";
  number: number;
}

export type IssueState = "open" | "closed" | "all";
export type PrState = "open" | "closed" | "merged" | "all";

export interface ListTarget extends CommonFields {
  kind: "list";
  state: IssueState | PrState;
  limit: number;
  author?: string;
  label?: string;
}

export type DiffMode = "list" | "all" | "slice";

export interface DiffTarget extends CommonFields {
  scheme: "pr";
  kind: "diff";
  number: number;
  mode: DiffMode;
  path?: string;
}

export interface ContentTarget {
  scheme: "github";
  kind: "content";
  host?: string;
  repo: RepoRef;
  refresh: boolean;
  input: string;
  path: string;
  ref?: string;
}

export type ParsedGithubTarget = SingleTarget | ListTarget | DiffTarget | ContentTarget;

export const LIST_LIMIT_DEFAULT = 30;
export const LIST_LIMIT_MAX = 100;

export function isGithubPath(target: string): boolean {
  return /^(gh|gh-pr|gh-issue):\/\//.test(target);
}

function positiveInt(value: string): number | undefined {
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseGithubPath(input: string): ParsedGithubTarget | null {
  const match = /^(gh|gh-pr|gh-issue):\/\/(.*)$/s.exec(input);
  if (!match) return null;
  const prefix = `${match[1]}://`;
  const scheme = match[1] === "gh" ? "github" : match[1] === "gh-pr" ? "pr" : "issue";
  const invalid = (detail: string): never => {
    throw new Error(`Invalid ${prefix} path '${input}': ${detail}. Expected ${prefix}${scheme === "github" ? "[host/]owner/repo[/path]" : "<number> or [host/]owner/repo[/<number>]"}${scheme === "pr" ? "; diffs: gh-pr://<number>/diff[/<path>] or gh-pr://<number>.diff" : ""}.`);
  };
  const question = match[2].indexOf("?");
  const rawPath = question < 0 ? match[2] : match[2].slice(0, question);
  const search = new URLSearchParams(question < 0 ? "" : match[2].slice(question + 1));
  const segments = rawPath.replace(/\/$/, "").split("/");
  if (segments.length === 1 && segments[0] === "") segments.pop();
  if (segments.some((s) => !s)) invalid("empty path segment");
  let host: string | undefined;
  // N.diff is a short PR form, not a hostname.
  if (segments[0]?.includes(".") && !/^\d+\.diff$/.test(segments[0])) {
    host = segments.shift()!.toLowerCase();
    if (!/^[A-Za-z0-9.-]+$/.test(host)) invalid("invalid host prefix");
  }
  let repo: RepoRef | undefined;
  if (scheme === "github" || (segments.length > 0 && !/^\d+(?:\.diff)?$/.test(segments[0]))) {
    if (scheme === "issue" && segments.length === 1 && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(segments[0])) {
      throw new Error(`gh-issue:// is for GitHub issues only (expected a number). '${segments[0]}' looks like a Jira/Linear key — use the jira-integration skill or the tracker's own tool.`);
    }
    if (segments.length < 2) invalid("expected owner/repo");
    const owner = segments.shift()!;
    const name = segments.shift()!;
    if (!/^[A-Za-z0-9-]+$/.test(owner)) invalid(`invalid owner segment '${owner}'`);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") invalid(`invalid repo segment '${name}'`);
    repo = { owner, repo: name };
  } else if (host) {
    invalid("a host prefix requires owner/repo");
  }
  const kind = scheme === "github" ? "content" : segments.length === 0 ? "list" : "single";
  const allowed = kind === "content" ? ["ref", "refresh"] : kind === "list" ? ["state", "limit", "author", "label", "refresh"] : ["refresh"];
  for (const key of search.keys()) {
    if (!allowed.includes(key)) invalid(`unknown query parameter '${key}'; allowed parameters: ${allowed.join(", ")}`);
  }
  const common = { host, repo, refresh: search.get("refresh") === "1", input };
  const validatePath = (parts: string[]): string => {
    for (const part of parts) {
      if (part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part)) invalid(`invalid path segment '${part}'`);
    }
    return parts.join("/");
  };
  if (scheme === "github") {
    const ref = search.get("ref") ?? undefined;
    if (ref !== undefined && !/^[A-Za-z0-9._/-]+$/.test(ref)) invalid(`invalid ref '${ref}'`);
    return { ...common, scheme, kind: "content", repo: repo!, path: validatePath(segments), ref };
  }
  if (kind === "list") {
    const state = search.get("state") ?? "open";
    const states = scheme === "pr" ? ["open", "closed", "merged", "all"] : ["open", "closed", "all"];
    if (!states.includes(state)) invalid(`invalid state '${state}'; expected ${states.join(", ")}`);
    const limit = search.has("limit") ? positiveInt(search.get("limit")!) : LIST_LIMIT_DEFAULT;
    if (limit === undefined) invalid("limit must be a positive integer");
    return { ...common, scheme, kind: "list", state: state as PrState, limit: Math.min(limit!, LIST_LIMIT_MAX), author: search.get("author") ?? undefined, label: search.get("label") ?? undefined };
  }
  const item = segments.shift()!;
  const fullDiff = item.endsWith(".diff");
  const number = positiveInt(fullDiff ? item.slice(0, -5) : item);
  if (number === undefined) {
    if (scheme === "issue" && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(item)) {
      throw new Error(`gh-issue:// is for GitHub issues only (expected a number). '${item}' looks like a Jira/Linear key — use the jira-integration skill or the tracker's own tool.`);
    }
    invalid("number must be a positive integer");
  }
  if (fullDiff || segments.length) {
    if (scheme !== "pr") invalid("diffs require gh-pr://<number>/diff or gh-pr://<number>.diff");
    if (fullDiff && segments.length) invalid("nothing may follow N.diff");
    if (!fullDiff && segments.shift() !== "diff") invalid("only /diff may follow the number");
    return { ...common, scheme: "pr", kind: "diff", number: number!, mode: fullDiff ? "all" : segments.length ? "slice" : "list", path: segments.length ? validatePath(segments) : undefined };
  }
  return { ...common, scheme, kind: "single", number: number! };
}
