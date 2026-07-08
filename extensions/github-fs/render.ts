/**
 * Renders `gh` JSON / diff output into the markdown the model reads.
 *
 * Pure and defensive: gh field sets drift across GHES versions, so every field
 * is read through optional accessors and missing data degrades to a placeholder
 * rather than throwing. Never emits tokens or secrets.
 */

import type { GithubScheme } from "./gh.js";
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

export function renderSingle(scheme: GithubScheme, json: Record<string, unknown>, repo: RepoRef | undefined): string {
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

  return lines.join("\n");
}

export function renderList(
  scheme: GithubScheme,
  items: Array<Record<string, unknown>>,
  repo: RepoRef | undefined,
  state: string,
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
      `- **#${number}** ${itemState}${draft} — ${title} · @${author}${updated ? ` · updated ${updated}` : ""}${labelSuffix}`,
    );
  }
  lines.push("", `${items.length} item(s). Read a single item with \`${scheme}://<number>\`.`);
  return lines.join("\n");
}

interface DiffFileSection {
  path: string;
  section: string;
}

const GIT_DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/** Split a unified diff into per-file sections keyed by the b-side path. */
export function splitDiffFiles(diff: string): DiffFileSection[] {
  const files: DiffFileSection[] = [];
  let current: DiffFileSection | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = GIT_DIFF_HEADER.exec(line);
      current = { path: match ? match[2] : line.slice("diff --git ".length), section: line };
    } else if (current) {
      current.section += `\n${line}`;
    }
  }
  if (current) files.push(current);
  return files;
}

export function renderDiff(diff: string, number: number, mode: DiffMode, index: number | undefined): string {
  const files = splitDiffFiles(diff);

  if (mode === "list") {
    const lines = [`# PR #${number} diff · ${files.length} file(s)`, ""];
    if (files.length === 0) {
      lines.push("_(no changes)_");
      return lines.join("\n");
    }
    files.forEach((file, i) => {
      lines.push(`${i + 1}. \`${file.path}\``);
    });
    lines.push("", `Read one file's diff with \`pr://${number}/diff/<index>\`, or all with \`pr://${number}/diff/all\`.`);
    return lines.join("\n");
  }

  if (mode === "slice") {
    if (index === undefined || index < 1 || index > files.length) {
      return `# PR #${number} diff\n\nNo file at index ${index ?? "?"}. This PR has ${files.length} changed file(s); read \`pr://${number}/diff\` for the list.`;
    }
    const file = files[index - 1];
    return `# PR #${number} diff · file ${index}/${files.length} · \`${file.path}\`\n\n${file.section}`;
  }

  // mode === "all"
  return `# PR #${number} diff · ${files.length} file(s)\n\n${diff}`;
}

export function renderTree(
  entries: Array<{ name: string; type: string; size: number }>,
  repo: RepoRef | undefined,
  path: string,
  ref?: string,
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
    lines.push(entry.type === "dir" ? `- ${entry.name}/` : `- ${entry.name}  (${entry.size} bytes)`);
  }
  lines.push("", `Read a file with \`github://${repoLabel(repo)}/${path ? `${path}/` : ""}<name>\`.`);
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
