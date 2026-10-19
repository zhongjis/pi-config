/**
 * Renders `gh` JSON / diff output into the markdown the model reads.
 *
 * Pure and defensive: gh field sets drift across GHES versions, so every field
 * is read through optional accessors and missing data degrades to a placeholder
 * rather than throwing. Never emits tokens or secrets.
 */

import type { GithubScheme, ReviewThreadsResult } from "./gh.js";
import type { RepoRef } from "./parse.js";
import { type RepoLocation, repoPath } from "./location.js";

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
  scheme: GithubScheme, json: Record<string, unknown>, location: RepoLocation,
  reviewThreads?: ReviewThreadsResult,
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
        else if (["failure", "cancelled", "timed_out", "action_required", "error", "startup_failure"].includes(result)) {
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
    const uri = `gh-pr://${repoPath(location)}${number}`;
    const oid = str(json.headRefOid);
    lines.push("", `Changed files: ${uri}/diff · Full diff: ${uri}.diff${oid ? ` · Files at head: gh://${repoPath(location)}?ref=${encodeURIComponent(oid)}` : ""}`);
  }

  return lines.join("\n");
}

export function renderList(
  scheme: GithubScheme,
  items: Array<Record<string, unknown>>,
  location: RepoLocation,
  state: string,
): string {
  const kind = scheme === "pr" ? "PRs" : "Issues";
  const lines: string[] = [`# ${kind} · ${repoLabel(location.repo)} · state=${state}`, ""];
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
      `- **#${number}** ${itemState}${draft} — ${title} · @${author}${updated ? ` · updated ${updated}` : ""}${labelSuffix} · \`gh-${scheme}://${repoPath(location)}${number}\``,
    );
  }
  lines.push("", `${items.length} item(s). Read a single item with \`gh-${scheme}://${repoPath(location)}<number>\`.`);
  return lines.join("\n");
}

export function renderTree(
  entries: Array<{ name: string; type: string; size: number }>,
  location: RepoLocation,
  path: string,
  ref?: string,
): string {
  const label = `${repoLabel(location.repo)}${path ? `/${path}` : ""}`;
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
    const uri = `gh://${repoPath(location)}${path ? `${path}/` : ""}${entry.name}${entry.type === "dir" ? "/" : ""}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    lines.push(`- ${entry.name}${entry.type === "dir" ? "/" : `  (${entry.size} bytes)`} · \`${uri}\``);
  }
  lines.push("", `Read a file with \`gh://${repoPath(location)}${path ? `${path}/` : ""}<name>${ref ? `?ref=${encodeURIComponent(ref)}` : ""}\`.`);
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
