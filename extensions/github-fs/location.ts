import type { RepoRef } from "./parse.js";

export interface RepoLocation {
  host: string;
  repo?: RepoRef;
}

export function hostPrefix(host: string): string {
  return host === "github.com" ? "" : `${host}/`;
}

export function repoPath({ host, repo }: RepoLocation): string {
  return `${hostPrefix(host)}${repo ? `${repo.owner}/${repo.repo}/` : ""}`;
}
