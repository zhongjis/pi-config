/**
 * Pure parser for `pr://` and `issue://` virtual paths.
 *
 * The built-in `read` tool never sees these schemes natively — the github-fs
 * extension intercepts them in a `tool_call` hook, so this module only turns a
 * raw path string into a structured target. It performs no I/O.
 *
 * Deliberately does NOT use `new URL()`: that lowercases the hostname, which
 * would corrupt case-preserving `owner/repo` segments carried in the path.
 * Everything after the scheme is split by hand.
 *
 * Grammar (segments are the `/`-split remainder after the scheme):
 *   pr://                         → list, default repo
 *   pr://owner/repo               → list, that repo
 *   pr://123                      → single item, default repo
 *   pr://owner/repo/123           → single item, that repo
 *   pr://123/diff[/all|/<i>]      → diff (pr only)
 *   pr://owner/repo/123/diff/...  → diff, that repo
 *   issue://…                     → same, minus diff
 *
 * Disambiguation: an all-digits first segment means the number form; any other
 * first segment means `owner/repo` (which then requires a repo segment).
 *
 * Query params: comments, state, limit, author, label, host, refresh.
 *
 * Not a github path → returns `null`. A github path that is malformed →
 * throws; the caller surfaces the message via a blocked tool call.
 */

export type GithubScheme = "pr" | "issue";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface CommonFields {
  scheme: GithubScheme;
  /** Explicit `?host=` override; undefined means "derive from cwd remote". */
  host?: string;
  /** Undefined means "derive default repo from cwd remote". */
  repo?: RepoRef;
  /** `?refresh=1` — bypass all cache TTLs. */
  refresh: boolean;
  /** The original input string, echoed back in output. */
  input: string;
}

export interface SingleTarget extends CommonFields {
  kind: "single";
  number: number;
  /** Include comments in the rendered view (default true). */
  comments: boolean;
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
  /** 1-based file index when mode === "slice". */
  index?: number;
}

export interface ContentTarget {
  scheme: "github";
  kind: "content";
  /** Explicit `?host=` override; undefined means "derive from cwd remote". */
  host?: string;
  /** Always fully-qualified for github:// paths. */
  repo: RepoRef;
  /** `?refresh=1` — bypass all cache TTLs. */
  refresh: boolean;
  /** The original input string, echoed back in output. */
  input: string;
  /** "" for repo root; slash-joined otherwise; no leading/trailing slash. */
  path: string;
  /** Undefined = default branch. */
  ref?: string;
}

export type ParsedGithubTarget = SingleTarget | ListTarget | DiffTarget | ContentTarget;

const SCHEME_PREFIXES: Record<GithubScheme, string> = {
  pr: "pr://",
  issue: "issue://",
};

const GITHUB_PREFIX = "github://";

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const HOST_PATTERN = /^[A-Za-z0-9.-]+$/;
const DIGITS_PATTERN = /^\d+$/;
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

export const LIST_LIMIT_DEFAULT = 30;
export const LIST_LIMIT_MAX = 100;

/** Cheap prefix check used by the hook before committing to a full parse. */
export function isGithubPath(target: string): boolean {
  return (
    target.startsWith(SCHEME_PREFIXES.pr) ||
    target.startsWith(SCHEME_PREFIXES.issue) ||
    target.startsWith(GITHUB_PREFIX)
  );
}

function detectScheme(target: string): { scheme: GithubScheme; remainder: string } | null {
  for (const scheme of Object.keys(SCHEME_PREFIXES) as GithubScheme[]) {
    const prefix = SCHEME_PREFIXES[scheme];
    if (target.startsWith(prefix)) {
      return { scheme, remainder: target.slice(prefix.length) };
    }
  }
  return null;
}

function parsePositiveInt(value: string): number | undefined {
  if (!DIGITS_PATTERN.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function requireNumber(scheme: GithubScheme, value: string): number {
  const parsed = parsePositiveInt(value);
  if (parsed === undefined) {
    throw new Error(`Invalid ${scheme}:// number '${value}': expected a positive integer.`);
  }
  return parsed;
}

function validateSegment(scheme: GithubScheme, value: string, label: string): string {
  if (!SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid ${scheme}:// ${label} segment '${value}'.`);
  }
  return value;
}

function parseQuery(scheme: GithubScheme, search: URLSearchParams): {
  host?: string;
  refresh: boolean;
  comments: boolean;
  state?: string;
  limit?: number;
  author?: string;
  label?: string;
} {
  const hostRaw = search.get("host") ?? undefined;
  if (hostRaw !== undefined && !HOST_PATTERN.test(hostRaw)) {
    throw new Error(`Invalid ${scheme}:// host '${hostRaw}'.`);
  }

  const commentsRaw = search.get("comments");
  let comments = true;
  if (commentsRaw !== null) {
    if (commentsRaw !== "0" && commentsRaw !== "1") {
      throw new Error(`Invalid ${scheme}:// comments '${commentsRaw}': expected 0 or 1.`);
    }
    comments = commentsRaw === "1";
  }

  const limitRaw = search.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    const parsed = parsePositiveInt(limitRaw);
    if (parsed === undefined) {
      throw new Error(`Invalid ${scheme}:// limit '${limitRaw}': expected a positive integer.`);
    }
    limit = Math.min(parsed, LIST_LIMIT_MAX);
  }

  return {
    host: hostRaw,
    refresh: search.get("refresh") === "1",
    comments,
    state: search.get("state") ?? undefined,
    limit,
    author: search.get("author") ?? undefined,
    label: search.get("label") ?? undefined,
  };
}

function resolveListState(scheme: GithubScheme, raw: string | undefined): IssueState | PrState {
  const allowed: string[] = scheme === "pr" ? ["open", "closed", "merged", "all"] : ["open", "closed", "all"];
  if (raw === undefined) return "open";
  if (!allowed.includes(raw)) {
    throw new Error(`Invalid ${scheme}:// state '${raw}': expected one of ${allowed.join(", ")}.`);
  }
  return raw as IssueState | PrState;
}

function parseDiffSuffix(scheme: GithubScheme, suffix: string[]): { mode: DiffMode; index?: number } {
  // suffix[0] is always "diff" here.
  if (suffix.length === 1) return { mode: "list" };
  if (suffix.length === 2) {
    const sub = suffix[1];
    if (sub === "all") return { mode: "all" };
    const index = parsePositiveInt(sub);
    if (index !== undefined) return { mode: "slice", index };
    throw new Error(`Invalid ${scheme}:// diff selector '${sub}': expected 'all' or a positive file index.`);
  }
  throw new Error(`Invalid ${scheme}:// diff path: too many segments after 'diff'.`);
}

/**
 * Parse a `pr://` / `issue://` path. Returns null for non-github paths so the
 * hook can bail cheaply; throws with an actionable message for malformed
 * github paths.
 */
export function parseGithubPath(input: string): ParsedGithubTarget | null {
  if (input.startsWith(GITHUB_PREFIX)) return parseGithubContentPath(input);

  const detected = detectScheme(input);
  if (!detected) return null;
  const { scheme } = detected;

  // Split query off the raw remainder before touching the path.
  const questionIndex = detected.remainder.indexOf("?");
  const pathPart = questionIndex >= 0 ? detected.remainder.slice(0, questionIndex) : detected.remainder;
  const queryPart = questionIndex >= 0 ? detected.remainder.slice(questionIndex + 1) : "";
  const query = parseQuery(scheme, new URLSearchParams(queryPart));

  const segments = pathPart.split("/").filter((seg) => seg.length > 0);
  const common: CommonFields = {
    scheme,
    host: query.host,
    refresh: query.refresh,
    input,
  };

  // pr:// or issue:// with no path → list of the default repo.
  if (segments.length === 0) {
    return {
      ...common,
      kind: "list",
      state: resolveListState(scheme, query.state),
      limit: query.limit ?? LIST_LIMIT_DEFAULT,
      author: query.author,
      label: query.label,
    };
  }

  const firstIsNumber = DIGITS_PATTERN.test(segments[0]);
  let repo: RepoRef | undefined;
  let rest: string[];

  if (firstIsNumber) {
    // Number form: pr://123[/diff...].
    rest = segments;
  } else {
    // owner/repo form.
    if (segments.length < 2) {
      throw new Error(
        `Invalid ${scheme}:// path '${input}': expected ${scheme}://<number>, ${scheme}://owner/repo, or ${scheme}://owner/repo/<number>.`,
      );
    }
    repo = {
      owner: validateSegment(scheme, segments[0], "owner"),
      repo: validateSegment(scheme, segments[1], "repo"),
    };
    rest = segments.slice(2);
    common.repo = repo;

    // owner/repo alone → list of that repo.
    if (rest.length === 0) {
      return {
        ...common,
        kind: "list",
        state: resolveListState(scheme, query.state),
        limit: query.limit ?? LIST_LIMIT_DEFAULT,
        author: query.author,
        label: query.label,
      };
    }
  }

  // rest[0] must be the item number.
  const number = requireNumber(scheme, rest[0]);
  const afterNumber = rest.slice(1);

  if (afterNumber.length === 0) {
    return { ...common, kind: "single", number, comments: query.comments };
  }

  // Only `diff` may follow the number.
  if (afterNumber[0] !== "diff") {
    throw new Error(`Invalid ${scheme}:// path '${input}': only '/diff' may follow the number.`);
  }
  if (scheme !== "pr") {
    throw new Error("issue:// paths do not support /diff. Use pr://<N>/diff for pull-request diffs.");
  }

  const diff = parseDiffSuffix(scheme, afterNumber);
  return {
    ...(common as CommonFields & { scheme: "pr" }),
    scheme: "pr",
    kind: "diff",
    number,
    mode: diff.mode,
    index: diff.index,
  };
}

/**
 * Parse a `github://owner/repo[/path][?ref=…&host=…&refresh=1]` path into a
 * {@link ContentTarget}. Fully-qualified only; throws for malformed input.
 */
function parseGithubContentPath(input: string): ContentTarget {
  const remainder = input.slice(GITHUB_PREFIX.length);
  const questionIndex = remainder.indexOf("?");
  const pathPart = questionIndex >= 0 ? remainder.slice(0, questionIndex) : remainder;
  const queryPart = questionIndex >= 0 ? remainder.slice(questionIndex + 1) : "";
  const search = new URLSearchParams(queryPart);

  const host = search.get("host") ?? undefined;
  if (host !== undefined && !HOST_PATTERN.test(host)) {
    throw new Error(`Invalid github:// host '${host}'.`);
  }
  const ref = search.get("ref") ?? undefined;
  if (ref !== undefined && !REF_PATTERN.test(ref)) {
    throw new Error(`Invalid github:// ref '${ref}'.`);
  }
  const refresh = search.get("refresh") === "1";

  const segments = pathPart.split("/").filter((seg) => seg.length > 0);
  if (segments.length < 2) {
    throw new Error(`Invalid github:// path '${input}': expected github://owner/repo[/path].`);
  }
  if (!SEGMENT_PATTERN.test(segments[0])) {
    throw new Error(`Invalid github:// owner segment '${segments[0]}'.`);
  }
  if (!SEGMENT_PATTERN.test(segments[1])) {
    throw new Error(`Invalid github:// repo segment '${segments[1]}'.`);
  }

  const pathSegs = segments.slice(2);
  for (const seg of pathSegs) {
    if (seg === "." || seg === ".." || /[\u0000-\u001f]/.test(seg)) {
      throw new Error(`Invalid github:// path segment '${seg}'.`);
    }
  }

  return {
    scheme: "github",
    kind: "content",
    host,
    repo: { owner: segments[0], repo: segments[1] },
    refresh,
    input,
    path: pathSegs.join("/"),
    ref,
  };
}
