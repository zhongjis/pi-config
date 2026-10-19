import { describe, expect, it } from "vitest";

import { isGithubPath, LIST_LIMIT_DEFAULT, parseGithubPath } from "../parse.js";

describe("isGithubPath", () => {
  it("recognizes gh-pr://, gh-issue://, and gh://", () => {
    expect(isGithubPath("gh-pr://123")).toBe(true);
    expect(isGithubPath("gh-issue://123")).toBe(true);
    expect(isGithubPath("gh://o/r")).toBe(true);
  });

  it("rejects other paths", () => {
    expect(isGithubPath("local://x")).toBe(false);
    expect(isGithubPath("/abs/path")).toBe(false);
    expect(isGithubPath("src/foo.ts")).toBe(false);
  });
});

describe("parseGithubPath - non-github", () => {
  it("returns null for non-github paths", () => {
    expect(parseGithubPath("local://x")).toBeNull();
    expect(parseGithubPath("src/foo.ts")).toBeNull();
  });
});

describe("parseGithubPath - single", () => {
  it("parses gh-pr://123", () => {
    const t = parseGithubPath("gh-pr://123");
    expect(t).toMatchObject({ scheme: "pr", kind: "single", number: 123, refresh: false });
    expect((t as { repo?: unknown }).repo).toBeUndefined();
  });

  it("parses gh-issue://42", () => {
    expect(parseGithubPath("gh-issue://42")).toMatchObject({ scheme: "issue", kind: "single", number: 42 });
  });

  it("parses fully-qualified owner/repo/number preserving case", () => {
    const t = parseGithubPath("gh-pr://Owner-X/Repo.JS/7");
    expect(t).toMatchObject({
      kind: "single",
      number: 7,
      repo: { owner: "Owner-X", repo: "Repo.JS" },
    });
  });

  it("honors refresh and a host prefix", () => {
    expect(parseGithubPath("gh-pr://git.corp.example.com/o/r/9?refresh=1")).toMatchObject({ refresh: true, host: "git.corp.example.com" });
  });

});

describe("parseGithubPath - list", () => {
  it("parses bare gh-pr:// as default-repo list", () => {
    const t = parseGithubPath("gh-pr://");
    expect(t).toMatchObject({ kind: "list", state: "open", limit: LIST_LIMIT_DEFAULT });
    expect((t as { repo?: unknown }).repo).toBeUndefined();
  });

  it("parses owner/repo as repo-scoped list", () => {
    expect(parseGithubPath("gh-issue://facebook/react")).toMatchObject({
      kind: "list",
      repo: { owner: "facebook", repo: "react" },
    });
  });

  it("applies state/limit/author/label", () => {
    expect(parseGithubPath("gh-pr://?state=merged&limit=5&author=octocat&label=bug")).toMatchObject({
      kind: "list",
      state: "merged",
      limit: 5,
      author: "octocat",
      label: "bug",
    });
  });

  it("caps limit at 100", () => {
    expect(parseGithubPath("gh-pr://?limit=9999")).toMatchObject({ kind: "list", limit: 100 });
  });

  it("allows merged state only for pr", () => {
    expect(parseGithubPath("gh-pr://?state=merged")).toMatchObject({ state: "merged" });
    expect(() => parseGithubPath("gh-issue://?state=merged")).toThrow(/state/);
  });
});

describe("parseGithubPath - diff", () => {
  it("parses diff file list", () => {
    expect(parseGithubPath("gh-pr://123/diff")).toMatchObject({ kind: "diff", number: 123, mode: "list" });
  });

  it("parses N.diff", () => {
    expect(parseGithubPath("gh-pr://123.diff")).toMatchObject({ kind: "diff", mode: "all" });
  });

  it("parses diff by file path", () => {
    expect(parseGithubPath("gh-pr://123/diff/src/a.ts")).toMatchObject({ kind: "diff", mode: "slice", path: "src/a.ts" });
  });

  it("parses qualified diff", () => {
    expect(parseGithubPath("gh-pr://o/r/8.diff")).toMatchObject({
      kind: "diff",
      number: 8,
      mode: "all",
      repo: { owner: "o", repo: "r" },
    });
  });

  it("rejects issue diffs", () => {
    expect(() => parseGithubPath("gh-issue://1/diff")).toThrow(/diff/);
  });

  it("rejects garbage after number", () => {
    expect(() => parseGithubPath("gh-pr://1/files")).toThrow(/diff/);
  });


});

describe("parseGithubPath - malformed", () => {
  it("rejects owner without repo", () => {
    expect(() => parseGithubPath("gh-pr://onlyowner")).toThrow();
  });

  it("rejects non-positive number", () => {
    expect(() => parseGithubPath("gh-pr://o/r/0")).toThrow(/number/);
  });

  it("rejects unknown query parameters", () => {
    expect(() => parseGithubPath("gh-pr://1?foo=1")).toThrow(/unknown query parameter 'foo'/);
  });
});

describe("parseGithubPath - github content", () => {
  it("parses gh://owner/repo/path into a content target", () => {
    expect(parseGithubPath("gh://o/r/src/a.ts")).toMatchObject({
      scheme: "github",
      kind: "content",
      repo: { owner: "o", repo: "r" },
      path: "src/a.ts",
    });
  });

  it("treats gh://owner/repo as the repo root (empty path)", () => {
    expect(parseGithubPath("gh://o/r")).toMatchObject({ kind: "content", path: "" });
  });

  it("drops a trailing slash from the path", () => {
    expect(parseGithubPath("gh://o/r/src/")).toMatchObject({ kind: "content", path: "src" });
  });

  it("captures ?ref and allows slashes in the ref", () => {
    expect(parseGithubPath("gh://o/r/a.ts?ref=v1.2.3")).toMatchObject({ ref: "v1.2.3" });
    expect(parseGithubPath("gh://o/r/a.ts?ref=feature/x")).toMatchObject({ ref: "feature/x" });
  });

  it("honors host prefix and refresh", () => {
    expect(parseGithubPath("gh://ghe.example.com/o/r/a.ts?refresh=1")).toMatchObject({
      host: "ghe.example.com",
      refresh: true,
    });
  });

  it("rejects a path with fewer than two segments", () => {
    expect(() => parseGithubPath("gh://owner")).toThrow(/owner\/repo/);
  });

  it("rejects a '..' path segment", () => {
    expect(() => parseGithubPath("gh://o/r/../etc")).toThrow(/segment/);
  });

  it("rejects a bad ref", () => {
    expect(() => parseGithubPath("gh://o/r/a.ts?ref=bad ref")).toThrow(/ref/);
  });
});

describe("grammar boundaries", () => {
  it.each(["gh://ghe.example.com/o/r/src/", "gh-pr://ghe.example.com/o/r/1/diff/src/a.ts", "gh-issue://ghe.example.com/o/r/1"])("parses host prefixes: %s", (path) => {
    expect(parseGithubPath(path)).toMatchObject({ host: "ghe.example.com", repo: { owner: "o", repo: "r" } });
  });
  it.each(["gh://ghe.example.com/owner.dot/r", "gh-pr://ghe.example.com/owner.dot/r/1", "gh-issue://ghe.example.com/owner.dot/r"])("rejects dotted owner: %s", (path) => {
    expect(() => parseGithubPath(path)).toThrow(/owner segment/);
  });
  it.each(["LM-223063", "CET-5352"])("explains tracker key %s", (key) => {
    expect(() => parseGithubPath(`gh-issue://${key}`)).toThrow(`gh-issue:// is for GitHub issues only (expected a number). '${key}' looks like a Jira/Linear key — use the jira-integration skill or the tracker's own tool.`);
    expect(() => parseGithubPath(`gh-issue://o/r/${key}`)).toThrow(/Jira\/Linear/);
  });
  it.each([
    ["gh://o/r?foo=1", "ref, refresh"],
    ["gh-pr://?foo=1", "state, limit, author, label, refresh"],
    ["gh-pr://1?state=open", "refresh"],
    ["gh-pr://1/diff?limit=1", "refresh"],
  ])("lists allowed query params for %s", (path, allowed) => {
    expect(() => parseGithubPath(path)).toThrow(`allowed parameters: ${allowed}`);
  });
  it.each([".", "..", "a\u0000b", "a\u007fb"])("rejects unsafe content and diff segment %s", (segment) => {
    expect(() => parseGithubPath(`gh://o/r/${segment}`)).toThrow(/path segment/);
    expect(() => parseGithubPath(`gh-pr://1/diff/${segment}`)).toThrow(/path segment/);
  });
  it("ignores trailing slashes for files and diff lists", () => {
    expect(parseGithubPath("gh://o/r/f.ts/")).toMatchObject({ kind: "content", path: "f.ts" });
    expect(parseGithubPath("gh-pr://1/diff/")).toMatchObject({ kind: "diff", mode: "list" });
  });
});
