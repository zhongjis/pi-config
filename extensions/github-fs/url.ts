import { hostPrefix } from "./location.js";
import { parseGithubPath } from "./parse.js";

/** Translate only supported GitHub web routes; other URLs remain native read paths. */
export async function translateGithubUrl(
  path: string,
  hasHost: (host: string) => Promise<boolean>,
): Promise<{ path: string; offset?: number; limit?: number } | undefined> {
  if (!/^https?:\/\//i.test(path)) return undefined;
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const raw = host === "raw.githubusercontent.com";
  if (host !== "github.com" && host !== "www.github.com" && !raw && !(await hasHost(host).catch(() => false))) return undefined;
  if (url.port || url.username || url.password) return undefined;
  let parts: string[];
  try {
    parts = url.pathname.replace(/^\/|\/$/g, "").split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [owner, repo, route, item, ...rest] = parts;
  if (!owner || !repo) return undefined;
  const base = `${hostPrefix(host === "www.github.com" || raw ? "github.com" : host)}${owner}/${repo}`;
  let canonical: string;
  if (raw || route === "blob" || route === "tree") {
    // ponytail: pasted refs are one segment; slash-containing branches need an explicit gh:// path with ?ref=.
    const ref = raw ? route : item;
    const file = raw ? parts.slice(3) : rest;
    if (!ref || (route !== "tree" && file.length === 0)) return undefined;
    canonical = `gh://${base}/${file.join("/")}?ref=${encodeURIComponent(ref)}`;
  } else if (parts.length === 2) {
    canonical = `gh://${base}/`;
  } else if (route === "pull" && /^\d+(?:\.diff)?$/.test(item ?? "")) {
    if (rest.length > 1 ||
      (rest.length === 1 && !["files", "commits", "checks"].includes(rest[0])) ||
      (item.endsWith(".diff") && rest.length)) return undefined;
    canonical = `gh-pr://${base}/${item}${rest[0] === "files" ? "/diff" : ""}`;
  } else if (route === "issues" && /^\d+$/.test(item ?? "") && rest.length === 0) {
    canonical = `gh-issue://${base}/${item}`;
  } else {
    return undefined;
  }
  try {
    parseGithubPath(canonical);
  } catch {
    return undefined;
  }
  const line = /^#L(\d+)(?:-L(\d+))?$/.exec(url.hash);
  const start = line ? Number(line[1]) : 0;
  const end = line ? Number(line[2] ?? line[1]) : 0;
  const hasRange = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start;
  return { path: canonical, ...(hasRange ? { offset: start, limit: end - start + 1 } : {}) };
}
