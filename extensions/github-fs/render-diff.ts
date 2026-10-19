import { type RepoLocation, repoPath } from "./location.js";
import type { DiffMode } from "./parse.js";

export interface DiffFileSection {
  path: string;
  section: string;
  status: "added" | "deleted" | "renamed" | "modified";
  additions: number;
  deletions: number;
}

// ponytail: git-quoted non-ASCII paths are not decoded; add Git C-style unquoting if needed.
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
      } else if (line.startsWith("--- a/")) oldPath = line.slice(6).replace(/\t$/, "");
      else if (line === "--- /dev/null" || line.startsWith("new file mode ")) current.status = "added";
      else if (line.startsWith("+++ b/")) patchPath = line.slice(6).replace(/\t$/, "");
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
  location: RepoLocation = { host: "github.com" },
): string {
  const uri = `gh-pr://${repoPath(location)}${number}`;
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

