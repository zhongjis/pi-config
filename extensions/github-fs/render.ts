/**
 * Renders `gh` JSON / diff output into the markdown the model reads.
 *
 * Pure and defensive: gh field sets drift across GHES versions, so every field
 * is read through optional accessors and missing data degrades to a placeholder
 * rather than throwing. Never emits tokens or secrets.
 */

import type { GithubScheme, ReviewThreadsResult } from "./gh.js";
import type { DiffMode, RepoRef } from "./parse.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function login(value: unknown): string {
  return str(asRecord(value).login) ?? "unknown";
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => str(asRecord(entry).name)).filter((name): name is string => Boolean(name));
}

function repoLabel(repo: RepoRef | undefined): string {
  return repo ? `${repo.owner}/${repo.repo}` : "current repo";
}

export function renderSingle(
  scheme: GithubScheme, json: Record<string, unknown>, repo: RepoRef | undefined,
  host = "github.com", reviewThreads?: ReviewThreadsResult,
): string {
  const number = num(json.number) ?? "?";
  const title = str(json.title) ?? "(no title)";
  const state = str(json.state) ?? "UNKNOWN";
  const lines: string[] = [`# ${scheme === "pr" ? "PR" : "Issue"} #${number} · ${title}`, ""];

  const meta: string[] = [`**${state}**`];
  if (json.isDraft === true) meta.push("draft");
  meta.push(`author @${login(json.author)}`);
  const labels = labelNames(json.labels);
  if (labels.length > 0) meta.push(`labels: ${labels.join(", ")}`);
  lines.push(meta.join(" · "));

  if (scheme === "pr") {
    const oid = str(json.headRefOid);
    if (oid) lines.push(`head ${oid.slice(0, 7)}`);
    const decision = str(json.reviewDecision);
    if (decision) lines.push(`review: ${decision}`);
    if (Array.isArray(json.statusCheckRollup)) {
      let passed = 0;
      let failed = 0;
      let pending = 0;
      const failing: string[] = [];
      for (const raw of json.statusCheckRollup) {
        const check = asRecord(raw);
        const result = (str(check.conclusion) ?? str(check.state) ?? "").toLowerCase();
        if (["success", "neutral", "skipped"].includes(result)) passed++;
        else if (["failure", "cancelled", "timed_out", "action_required", "error"].includes(result)) {
          failed++;
          failing.push(str(check.name) ?? str(check.context) ?? "unknown");
        } else pending++;
      }
      lines.push(`checks: ${passed} passed, ${failed} failed, ${pending} pending`);
      if (failing.length) lines.push(`failing: ${failing.join(", ")}`);
    }
    const base = str(json.baseRefName);
    const head = str(json.headRefName);
    if (base && head) lines.push(`branch: \`${head}\` → \`${base}\``);
    const additions = num(json.additions);
    const deletions = num(json.deletions);
    if (additions !== undefined || deletions !== undefined) {
      lines.push(`changes: +${additions ?? 0} / -${deletions ?? 0}`);
    }
    const mergedAt = str(json.mergedAt);
    if (mergedAt) lines.push(`merged: ${mergedAt}`);
  }

  const createdAt = str(json.createdAt);
  const updatedAt = str(json.updatedAt);
  if (createdAt) lines.push(`created: ${createdAt}`);
  if (updatedAt) lines.push(`updated: ${updatedAt}`);
  const url = str(json.url);
  if (url) lines.push(`url: ${url}`);

  lines.push("", "---", "", str(json.body) ?? "_(no description)_");

  if (scheme === "pr") {
    if (Array.isArray(json.reviews)) {
      const reviews = json.reviews.map(asRecord).filter((review) =>
        review.state !== "COMMENTED" || (str(review.body)?.trim().length ?? 0) > 0);
      lines.push("", `## Reviews (${reviews.length})`);
      for (const review of reviews) {
        const when = str(review.submittedAt);
        lines.push("", `### @${login(review.author)} · ${str(review.state) ?? "UNKNOWN"}${when ? ` · ${when}` : ""}`, "", str(review.body) ?? "");
      }
    }
    if (reviewThreads?.unavailable !== undefined) {
      lines.push("", `_Review threads unavailable: ${reviewThreads.unavailable}_`);
    } else if (reviewThreads?.threads) {
      const threads = reviewThreads.threads.map(asRecord);
      const resolved = threads.filter((thread) => thread.isResolved === true);
      lines.push("", `## Review threads (${threads.length}, ${resolved.length} resolved)`);
      for (const thread of [...threads.filter((thread) => thread.isResolved !== true), ...resolved]) {
        const location = `${str(thread.path) ?? "?"}:${num(thread.line) ?? num(thread.originalLine) ?? "?"}`;
        const id = str(thread.id) ?? "?";
        if (thread.isResolved === true) {
          lines.push(`- ${location} · resolved by @${login(thread.resolvedBy)} · thread ${id}`);
          continue;
        }
        lines.push("", `### ${location} · unresolved${thread.isOutdated === true ? " · outdated" : ""} · thread ${id}`);
        const comments = asRecord(thread.comments).nodes;
        if (Array.isArray(comments)) {
          for (const raw of comments) {
            const comment = asRecord(raw);
            const when = str(comment.createdAt);
            lines.push("", `**@${login(comment.author)}**${when ? ` · ${when}` : ""} · comment ${num(comment.databaseId) ?? "?"}`, "", str(comment.body) ?? "");
          }
        }
      }
    }
  }

  if (Array.isArray(json.comments)) {
    lines.push("", `## Comments (${json.comments.length})`);
    if (json.comments.length === 0) {
      lines.push("", "_(none)_");
    }
    for (const raw of json.comments) {
      const comment = asRecord(raw);
      const when = str(comment.createdAt);
      lines.push("", `### @${login(comment.author)}${when ? ` · ${when}` : ""}`, "", str(comment.body) ?? "");
    }
  }

  if (scheme === "pr") {
    const uri = `gh-pr://${repoPath(repo, host)}${number}`;
    const oid = str(json.headRefOid);
    lines.push("", `Changed files: ${uri}/diff · Full diff: ${uri}.diff${oid ? ` · Files at head: gh://${repoPath(repo, host)}?ref=${encodeURIComponent(oid)}` : ""}`);
  }

  return lines.join("\n");
}

function repoPath(repo: RepoRef | undefined, host: string): string {
  return `${host === "github.com" ? "" : `${host}/`}${repo ? `${repo.owner}/${repo.repo}/` : ""}`;
}

export function renderList(
  scheme: GithubScheme,
  items: Array<Record<string, unknown>>,
  repo: RepoRef | undefined,
  state: string,
  host = "github.com",
): string {
  const kind = scheme === "pr" ? "PRs" : "Issues";
  const lines: string[] = [`# ${kind} · ${repoLabel(repo)} · state=${state}`, ""];
  if (items.length === 0) {
    lines.push("_(no matching items)_");
    return lines.join("\n");
  }
  for (const raw of items) {
    const item = asRecord(raw);
    const number = num(item.number) ?? "?";
    const itemState = str(item.state) ?? "";
    const title = str(item.title) ?? "(no title)";
    const draft = item.isDraft === true ? " [draft]" : "";
    const author = login(item.author);
    const updated = str(item.updatedAt);
    const labels = labelNames(item.labels);
    const labelSuffix = labels.length > 0 ? ` · ${labels.join(", ")}` : "";
    lines.push(
      `- **#${number}** ${itemState}${draft} — ${title} · @${author}${updated ? ` · updated ${updated}` : ""}${labelSuffix} · \`gh-${scheme}://${repoPath(repo, host)}${number}\``,
    );
  }
  lines.push("", `${items.length} item(s). Read a single item with \`gh-${scheme}://${repoPath(repo, host)}<number>\`.`);
  return lines.join("\n");
}

interface DiffFileSection {
  path: string;
  section: string;
  status: "added" | "deleted" | "renamed" | "modified";
  additions: number;
  deletions: number;
}

const GIT_DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/** Prefer patch paths over the ambiguous git header, preserving each full section. */
export function splitDiffFiles(diff: string): DiffFileSection[] {
  const files: DiffFileSection[] = [];
  let current: DiffFileSection | undefined;
  let oldPath: string | undefined;
  let patchPath: string | undefined;
  let renamedPath: string | undefined;
  let inHunk = false;
  const finish = () => {
    if (!current) return;
    current.path = patchPath ?? renamedPath ?? oldPath ?? current.path;
    files.push(current);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      const match = GIT_DIFF_HEADER.exec(line);
      current = { path: match ? match[2] : line.slice("diff --git ".length), section: line,
        status: "modified", additions: 0, deletions: 0 };
      oldPath = patchPath = renamedPath = undefined;
      inHunk = false;
    } else if (current) {
      current.section += `\n${line}`;
      if (line.startsWith("@@ ")) inHunk = true;
      if (inHunk) {
        if (line.startsWith("+")) current.additions++;
        else if (line.startsWith("-")) current.deletions++;
      } else if (line.startsWith("--- a/")) oldPath = line.slice(6);
      else if (line === "--- /dev/null" || line.startsWith("new file mode ")) current.status = "added";
      else if (line.startsWith("+++ b/")) patchPath = line.slice(6);
      else if (line === "+++ /dev/null" || line.startsWith("deleted file mode ")) current.status = "deleted";
      else if (line.startsWith("rename to ")) {
        renamedPath = line.slice(10);
        current.status = "renamed";
      }
    }
  }
  finish();
  return files;
}

export function renderDiff(
  diff: string, number: number, mode: DiffMode, path: string | undefined,
  repo?: RepoRef, host = "github.com",
): string {
  const uri = `gh-pr://${repoPath(repo, host)}${number}`;
  const files = splitDiffFiles(diff);

  if (mode === "list") {
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const lines = [`# PR #${number} diff · ${files.length} file(s) · +${additions} / -${deletions}`, ""];
    if (files.length === 0) {
      lines.push("_(no changes)_");
      return lines.join("\n");
    }
    files.forEach((file, i) => {
      lines.push(`${i + 1}. \`${file.path}\` · +${file.additions} / -${file.deletions} · ${file.status} · \`${uri}/diff/${file.path}\``);
    });
    lines.push("", `Read one file's diff with \`${uri}/diff/<path>\`, or all with \`${uri}.diff\`.`);
    return lines.join("\n");
  }

  if (mode === "slice") {
    const index = files.findIndex((file) => file.path === path);
    if (index < 0) {
      return `# PR #${number} diff\n\nNo diff for path '${path ?? "?"}'. This PR has ${files.length} changed file(s); read \`${uri}/diff\` for the list.`;
    }
    const file = files[index];
    return `# PR #${number} diff · file ${index + 1}/${files.length} · \`${file.path}\`\n\n${file.section}`;
  }

  // mode === "all"
  return `# PR #${number} diff · ${files.length} file(s)\n\n${diff}`;
}

export function renderTree(
  entries: Array<{ name: string; type: string; size: number }>,
  repo: RepoRef | undefined,
  path: string,
  ref?: string,
  host = "github.com",
): string {
  const label = `${repoLabel(repo)}${path ? `/${path}` : ""}`;
  const lines: string[] = [
    `# ${label} · tree${ref ? `@${ref}` : ""} · ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`,
    "",
  ];
  if (entries.length === 0) {
    lines.push("_(empty)_");
    return lines.join("\n");
  }
  const sorted = [...entries].sort((a, b) => {
    const aDir = a.type === "dir";
    const bDir = b.type === "dir";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    const uri = `gh://${repoPath(repo, host)}${path ? `${path}/` : ""}${entry.name}${entry.type === "dir" ? "/" : ""}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    lines.push(`- ${entry.name}${entry.type === "dir" ? "/" : `  (${entry.size} bytes)`} · \`${uri}\``);
  }
  lines.push("", `Read a file with \`gh://${repoPath(repo, host)}${path ? `${path}/` : ""}<name>${ref ? `?ref=${encodeURIComponent(ref)}` : ""}\`.`);
  return lines.join("\n");
}

export function renderContentStub(
  res: { kind: string; name: string; path: string; size?: number; sha: string; htmlUrl?: string; type?: string },
  repo: RepoRef | undefined,
  ref?: string,
): string {
  const label = `${repoLabel(repo)}/${res.path}${ref ? `@${ref}` : ""}`;
  const meta: string[] = [];
  if (typeof res.size === "number") meta.push(`${res.size} bytes`);
  meta.push(`sha ${res.sha}`);
  if (res.htmlUrl) meta.push(res.htmlUrl);
  const metaLine = meta.join(" · ");

  if (res.kind === "binary") {
    return [`# ${label} · binary file`, "", metaLine, "", "_Not inlined. Open the URL or use the browser to view._"].join("\n");
  }
  if (res.kind === "too-large") {
    return [
      `# ${label} · too large to inline`,
      "",
      metaLine,
      "",
      "_GitHub does not inline files over 1 MiB. View on the web or fetch via gh/git._",
    ].join("\n");
  }
  const type = res.type ?? "unknown";
  return [
    `# ${label} · ${type}`,
    "",
    metaLine,
    "",
    `_This entry is a ${type}; only file contents and directory listings are supported._`,
  ].join("\n");
}
