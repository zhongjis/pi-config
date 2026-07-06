import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCache } from "../cache.js";
import type { AuthResolver, GhRunner } from "../gh.js";
import { parseGithubPath } from "../parse.js";
import { parseRemoteUrl, type ResolveDeps, resolveGithubView } from "../resolve.js";

describe("parseRemoteUrl", () => {
  it("parses scp-like git@host:owner/repo.git", () => {
    expect(parseRemoteUrl("git@github.com:octo/repo.git")).toEqual({
      host: "github.com",
      owner: "octo",
      repo: "repo",
    });
  });

  it("parses https URLs and strips .git", () => {
    expect(parseRemoteUrl("https://git.corp.adobe.com/team/service.git")).toEqual({
      host: "git.corp.adobe.com",
      owner: "team",
      repo: "service",
    });
  });

  it("parses ssh:// URLs with user and port", () => {
    expect(parseRemoteUrl("ssh://git@example.com:2222/o/r")).toEqual({
      host: "example.com",
      owner: "o",
      repo: "r",
    });
  });

  it("takes the last two path segments (subgroups)", () => {
    expect(parseRemoteUrl("https://gitlab.com/group/sub/proj.git")).toMatchObject({ owner: "sub", repo: "proj" });
  });

  it("returns null for junk", () => {
    expect(parseRemoteUrl("not a url")).toBeNull();
    expect(parseRemoteUrl("")).toBeNull();
  });
});

describe("resolveGithubView", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghfs-resolve-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<ResolveDeps> = {}): { deps: ResolveDeps; runCalls: string[][] } {
    const runCalls: string[][] = [];
    const run: GhRunner = async (options) => {
      runCalls.push(options.args);
      const [a, b] = options.args;
      if (a === "issue" && b === "view") return { code: 0, stdout: JSON.stringify({ number: 7, title: "T", state: "OPEN" }), stderr: "" };
      if (a === "pr" && b === "view") return { code: 0, stdout: JSON.stringify({ number: 7, title: "P", state: "MERGED" }), stderr: "" };
      if (a === "pr" && b === "list") return { code: 0, stdout: "[]", stderr: "" };
      if (a === "pr" && b === "diff") return { code: 0, stdout: "diff --git a/x b/x\n+y", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const auth: AuthResolver = {
      resolve: async () => ({ user: "tester", token: "tok" }),
    };
    const deps: ResolveDeps = {
      run,
      auth,
      cache: createCache({ agentDir: dir }),
      gitRemoteUrl: async () => "git@github.com:octo/repo.git",
      ...overrides,
    };
    return { deps, runCalls };
  }

  it("resolves a single issue and materializes markdown", async () => {
    const { deps } = makeDeps();
    const path = await resolveGithubView("/some/cwd", parseGithubPath("issue://7")!, deps);
    const { readFile } = await import("node:fs/promises");
    const md = await readFile(path, "utf8");
    expect(md).toContain("# Issue #7 · T");
  });

  it("derives repo from the git remote when path omits owner/repo", async () => {
    const { deps, runCalls } = makeDeps();
    await resolveGithubView("/cwd", parseGithubPath("issue://7")!, deps);
    const viewCall = runCalls.find((a) => a[0] === "issue" && a[1] === "view");
    expect(viewCall).toContain("github.com/octo/repo");
  });

  it("uses explicit owner/repo and ?host over the remote", async () => {
    const { deps, runCalls } = makeDeps();
    await resolveGithubView("/cwd", parseGithubPath("pr://acme/widget/7?host=ghe.example.com")!, deps);
    const viewCall = runCalls.find((a) => a[0] === "pr" && a[1] === "view");
    expect(viewCall).toContain("ghe.example.com/acme/widget");
  });

  it("caches: second read of a merged PR does not re-fetch", async () => {
    const { deps, runCalls } = makeDeps();
    const target = () => parseGithubPath("pr://7")!;
    await resolveGithubView("/cwd", target(), deps);
    const viewsBefore = runCalls.filter((a) => a[0] === "pr" && a[1] === "view").length;
    await resolveGithubView("/cwd", target(), deps);
    const viewsAfter = runCalls.filter((a) => a[0] === "pr" && a[1] === "view").length;
    expect(viewsBefore).toBe(1);
    expect(viewsAfter).toBe(1); // terminal (MERGED) → served from cache
  });

  it("throws an actionable error when repo cannot be determined", async () => {
    const { deps } = makeDeps({ gitRemoteUrl: async () => null });
    await expect(resolveGithubView("/cwd", parseGithubPath("issue://7")!, deps)).rejects.toThrow(
      /Cannot determine a repository/,
    );
  });
});
