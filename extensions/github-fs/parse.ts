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

const LIST_STATES: Record<GithubScheme, readonly PrState[]> = {
  pr: ["open", "closed", "merged", "all"],
  issue: ["open", "closed", "all"],
};

function isListState(value: string, scheme: GithubScheme): value is PrState {
  return LIST_STATES[scheme].some((state) => state === value);
}

function rejectTrackerKey(value: string): void {
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value)) {
    throw new Error(
      `gh-issue:// is for GitHub issues only (expected a number). '${value}' looks like a Jira/Linear key — ` +
      "use the jira-integration skill or the tracker's own tool.",
    );
  }
}

export function parseGithubPath(input: string): ParsedGithubTarget | null {
  const match = /^(gh|gh-pr|gh-issue):\/\/(.*)$/s.exec(input);
  if (!match) return null;
  const prefix = `${match[1]}://`;
  const scheme = match[1] === "gh" ? "github" : match[1] === "gh-pr" ? "pr" : "issue";
  function invalid(detail: string): never {
    const form = scheme === "github" ? "[host/]owner/repo[/path]" : "<number> or [host/]owner/repo[/<number>]";
    const diffs = scheme === "pr" ? "; diffs: gh-pr://<number>/diff[/<path>] or gh-pr://<number>.diff" : "";
    throw new Error(`Invalid ${prefix} path '${input}': ${detail}. Expected ${prefix}${form}${diffs}.`);
  }
  const question = match[2].indexOf("?");
  const rawPath = question < 0 ? match[2] : match[2].slice(0, question);
  const search = new URLSearchParams(question < 0 ? "" : match[2].slice(question + 1));
  let segments = rawPath.replace(/\/$/, "").split("/");
  if (segments.length === 1 && segments[0] === "") segments.pop();
  if (segments.some((s) => !s)) invalid("empty path segment");
  let host: string | undefined;
  const [first] = segments;
  // N.diff is a short PR form, not a hostname.
  if (first !== undefined && first.includes(".") && !/^\d+\.diff$/.test(first)) {
    host = first.toLowerCase();
    segments = segments.slice(1);
    if (!/^[A-Za-z0-9.-]+$/.test(host)) invalid("invalid host prefix");
  }
  let repo: RepoRef | undefined;
  if (scheme === "github" || (segments.length > 0 && !/^\d+(?:\.diff)?$/.test(segments[0]))) {
    const [owner, name, ...rest] = segments;
    if (scheme === "issue" && segments.length === 1 && owner !== undefined) rejectTrackerKey(owner);
    if (owner === undefined || name === undefined) invalid("expected owner/repo");
    if (!/^[A-Za-z0-9-]+$/.test(owner)) invalid(`invalid owner segment '${owner}'`);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") invalid(`invalid repo segment '${name}'`);
    repo = { owner, repo: name };
    segments = rest;
  } else if (host) {
    invalid("a host prefix requires owner/repo");
  }
  const kind = scheme === "github" ? "content" : segments.length === 0 ? "list" : "single";
  const allowed = kind === "content" ? ["ref", "refresh"]
    : kind === "list" ? ["state", "limit", "author", "label", "refresh"] : ["refresh"];
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
    if (repo === undefined) invalid("expected owner/repo");
    const ref = search.get("ref") ?? undefined;
    if (ref !== undefined && !/^[A-Za-z0-9._/-]+$/.test(ref)) invalid(`invalid ref '${ref}'`);
    return { ...common, scheme, kind: "content", repo, path: validatePath(segments), ref };
  }
  if (kind === "list") {
    const state = search.get("state") ?? "open";
    if (!isListState(state, scheme)) invalid(`invalid state '${state}'; expected ${LIST_STATES[scheme].join(", ")}`);
    const limitRaw = search.get("limit");
    const limit = limitRaw === null ? LIST_LIMIT_DEFAULT : positiveInt(limitRaw);
    if (limit === undefined) invalid("limit must be a positive integer");
    return {
      ...common, scheme, kind: "list", state, limit: Math.min(limit, LIST_LIMIT_MAX),
      author: search.get("author") ?? undefined,
      label: search.get("label") ?? undefined,
    };
  }
  const [item, ...suffix] = segments;
  if (item === undefined) invalid("number must be a positive integer");
  const fullDiff = item.endsWith(".diff");
  const number = positiveInt(fullDiff ? item.slice(0, -5) : item);
  if (number === undefined) {
    if (scheme === "issue") rejectTrackerKey(item);
    invalid("number must be a positive integer");
  }
  if (fullDiff || suffix.length) {
    if (scheme !== "pr") invalid("diffs require gh-pr://<number>/diff or gh-pr://<number>.diff");
    if (fullDiff && suffix.length) invalid("nothing may follow N.diff");
    const [selector, ...diffPath] = suffix;
    if (!fullDiff && selector !== "diff") invalid("only /diff may follow the number");
    return {
      ...common, scheme: "pr", kind: "diff", number,
      mode: fullDiff ? "all" : diffPath.length ? "slice" : "list",
      path: diffPath.length ? validatePath(diffPath) : undefined,
    };
  }
  return { ...common, scheme, kind: "single", number };
}
