import { describe, expect, it } from "vitest";

import { isGithubPath, LIST_LIMIT_DEFAULT, parseGithubPath } from "../parse.js";

describe("isGithubPath", () => {
  it("recognizes pr://, issue://, and github://", () => {
    expect(isGithubPath("pr://123")).toBe(true);
    expect(isGithubPath("issue://123")).toBe(true);
    expect(isGithubPath("github://o/r")).toBe(true);
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
  it("parses pr://123", () => {
    const t = parseGithubPath("pr://123");
    expect(t).toMatchObject({ scheme: "pr", kind: "single", number: 123, comments: true, refresh: false });
    expect((t as { repo?: unknown }).repo).toBeUndefined();
  });

  it("parses issue://42", () => {
    expect(parseGithubPath("issue://42")).toMatchObject({ scheme: "issue", kind: "single", number: 42 });
  });

  it("parses fully-qualified owner/repo/number preserving case", () => {
    const t = parseGithubPath("pr://Owner-X/Repo.JS/7");
    expect(t).toMatchObject({
      kind: "single",
      number: 7,
      repo: { owner: "Owner-X", repo: "Repo.JS" },
    });
  });

  it("suppresses comments with ?comments=0", () => {
    expect(parseGithubPath("issue://5?comments=0")).toMatchObject({ kind: "single", comments: false });
  });

  it("keeps comments with ?comments=1", () => {
    expect(parseGithubPath("issue://5?comments=1")).toMatchObject({ kind: "single", comments: true });
  });

  it("honors ?refresh=1 and ?host=", () => {
    const t = parseGithubPath("pr://9?refresh=1&host=git.corp.example.com");
    expect(t).toMatchObject({ kind: "single", refresh: true, host: "git.corp.example.com" });
  });
});

describe("parseGithubPath - list", () => {
  it("parses bare pr:// as default-repo list", () => {
    const t = parseGithubPath("pr://");
    expect(t).toMatchObject({ kind: "list", state: "open", limit: LIST_LIMIT_DEFAULT });
    expect((t as { repo?: unknown }).repo).toBeUndefined();
  });

  it("parses owner/repo as repo-scoped list", () => {
    expect(parseGithubPath("issue://facebook/react")).toMatchObject({
      kind: "list",
      repo: { owner: "facebook", repo: "react" },
    });
  });

  it("applies state/limit/author/label", () => {
    expect(parseGithubPath("pr://?state=merged&limit=5&author=octocat&label=bug")).toMatchObject({
      kind: "list",
      state: "merged",
      limit: 5,
      author: "octocat",
      label: "bug",
    });
  });

  it("caps limit at 100", () => {
    expect(parseGithubPath("pr://?limit=9999")).toMatchObject({ kind: "list", limit: 100 });
  });

  it("allows merged state only for pr", () => {
    expect(parseGithubPath("pr://?state=merged")).toMatchObject({ state: "merged" });
    expect(() => parseGithubPath("issue://?state=merged")).toThrow(/state/);
  });
});

describe("parseGithubPath - diff", () => {
  it("parses diff file list", () => {
    expect(parseGithubPath("pr://123/diff")).toMatchObject({ kind: "diff", number: 123, mode: "list" });
  });

  it("parses diff/all", () => {
    expect(parseGithubPath("pr://123/diff/all")).toMatchObject({ kind: "diff", mode: "all" });
  });

  it("parses diff slice index (1-based)", () => {
    expect(parseGithubPath("pr://123/diff/2")).toMatchObject({ kind: "diff", mode: "slice", index: 2 });
  });

  it("parses qualified diff", () => {
    expect(parseGithubPath("pr://o/r/8/diff/all")).toMatchObject({
      kind: "diff",
      number: 8,
      mode: "all",
      repo: { owner: "o", repo: "r" },
    });
  });

  it("rejects issue diffs", () => {
    expect(() => parseGithubPath("issue://1/diff")).toThrow(/diff/);
  });

  it("rejects garbage after number", () => {
    expect(() => parseGithubPath("pr://1/files")).toThrow(/diff/);
  });

  it("rejects bad diff selector", () => {
    expect(() => parseGithubPath("pr://1/diff/bogus")).toThrow(/diff selector/);
  });
});

describe("parseGithubPath - malformed", () => {
  it("rejects owner without repo", () => {
    expect(() => parseGithubPath("pr://onlyowner")).toThrow();
  });

  it("rejects non-positive number", () => {
    expect(() => parseGithubPath("pr://o/r/0")).toThrow(/number/);
  });

  it("rejects bad comments value", () => {
    expect(() => parseGithubPath("pr://1?comments=2")).toThrow(/comments/);
  });

  it("rejects bad host", () => {
    expect(() => parseGithubPath("pr://1?host=bad host")).toThrow(/host/);
  });
});

describe("parseGithubPath - github content", () => {
  it("parses github://owner/repo/path into a content target", () => {
    expect(parseGithubPath("github://o/r/src/a.ts")).toMatchObject({
      scheme: "github",
      kind: "content",
      repo: { owner: "o", repo: "r" },
      path: "src/a.ts",
    });
  });

  it("treats github://owner/repo as the repo root (empty path)", () => {
    expect(parseGithubPath("github://o/r")).toMatchObject({ kind: "content", path: "" });
  });

  it("drops a trailing slash from the path", () => {
    expect(parseGithubPath("github://o/r/src/")).toMatchObject({ kind: "content", path: "src" });
  });

  it("captures ?ref and allows slashes in the ref", () => {
    expect(parseGithubPath("github://o/r/a.ts?ref=v1.2.3")).toMatchObject({ ref: "v1.2.3" });
    expect(parseGithubPath("github://o/r/a.ts?ref=feature/x")).toMatchObject({ ref: "feature/x" });
  });

  it("honors ?host and ?refresh", () => {
    expect(parseGithubPath("github://o/r/a.ts?host=ghe.example.com&refresh=1")).toMatchObject({
      host: "ghe.example.com",
      refresh: true,
    });
  });

  it("rejects a path with fewer than two segments", () => {
    expect(() => parseGithubPath("github://owner")).toThrow(/owner\/repo/);
  });

  it("rejects a '..' path segment", () => {
    expect(() => parseGithubPath("github://o/r/../etc")).toThrow(/segment/);
  });

  it("rejects a bad ref", () => {
    expect(() => parseGithubPath("github://o/r/a.ts?ref=bad ref")).toThrow(/ref/);
  });
});
