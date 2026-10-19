import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCache } from "../cache.js";
import type { AuthResolver, GhRunner } from "../gh.js";
import { parseGithubPath } from "../parse.js";
import { createRemoteResolver, parseRemoteUrl, type ResolveDeps, resolveGithubView } from "../resolve.js";

describe("parseRemoteUrl", () => {
  it("parses scp-like git@host:owner/repo.git", () => {
    expect(parseRemoteUrl("git@github.com:octo/repo.git")).toEqual({
      host: "github.com",
      owner: "octo",
      repo: "repo",
      ssh: true,
    });
  });

  it("parses https URLs and strips .git", () => {
    expect(parseRemoteUrl("https://git.corp.adobe.com/team/service.git")).toEqual({
      host: "git.corp.adobe.com",
      owner: "team",
      repo: "service",
      ssh: false,
    });
  });

  it("parses ssh:// URLs with user and port", () => {
    expect(parseRemoteUrl("ssh://git@example.com:2222/o/r")).toEqual({
      host: "example.com",
      owner: "o",
      repo: "r",
      ssh: true,
    });
  });

  it("takes the last two path segments (subgroups)", () => {
    expect(parseRemoteUrl("https://gitlab.com/group/sub/proj.git")).toMatchObject({ owner: "sub", repo: "proj" });
  });

  it("flags scp-form SSH-alias hosts as ssh (for later canonicalization)", () => {
    expect(parseRemoteUrl("git@github.com-zshen_adobe:acme/app.git")).toEqual({
      host: "github.com-zshen_adobe",
      owner: "acme",
      repo: "app",
      ssh: true,
    });
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

  function makeDeps(overrides: Partial<ResolveDeps> & { gitRemoteUrl?: (cwd: string) => Promise<string | null>; resolveHostAlias?: (host: string) => Promise<string> } = {}): { deps: ResolveDeps; runCalls: string[][] } {
    const runCalls: string[][] = [];
    const run: GhRunner = async (options) => {
      runCalls.push(options.args);
      const [a, b] = options.args;
      if (a === "issue" && b === "view") return { code: 0, stdout: JSON.stringify({ number: 7, title: "T", state: "OPEN" }), stderr: "" };
      if (a === "pr" && b === "view") return { code: 0, stdout: JSON.stringify({ number: 7, title: "P", state: "MERGED" }), stderr: "" };
      if (a === "pr" && b === "list") return { code: 0, stdout: "[]", stderr: "" };
      if (a === "pr" && b === "diff") return { code: 0, stdout: "diff --git a/x b/x\n+y", stderr: "" };
      if (a === "api" && typeof b === "string" && b.includes("/contents/")) {
        const file = b.split("/contents/")[1].split("?")[0];
        const name = file.split("/").pop() ?? file;
        const body = name.endsWith(".json") ? '{"ok":true}\n' : "export const a = 1;\n";
        return {
          code: 0,
          stdout: JSON.stringify({
            type: "file",
            name,
            path: file,
            size: body.length,
            sha: "sha1",
            encoding: "base64",
            content: Buffer.from(body).toString("base64"),
          }),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const auth: AuthResolver = {
      resolve: async () => ({ user: "tester", token: "tok" }),
      hasHost: async () => true,
    };
    const deps: ResolveDeps = {
      run,
      auth,
      cache: createCache({ agentDir: dir }),
      remote: createRemoteResolver(overrides.gitRemoteUrl ?? (async () => "git@github.com:octo/repo.git"), overrides.resolveHostAlias ?? (async (host) => host)),
      ...overrides,
    };
    return { deps, runCalls };
  }

  it("resolves a single issue and materializes markdown", async () => {
    const { deps } = makeDeps();
    const path = await resolveGithubView("/some/cwd", parseGithubPath("gh-issue://7")!, deps);
    const { readFile } = await import("node:fs/promises");
    const md = await readFile(path, "utf8");
    expect(md).toContain("# Issue #7 · T");
  });

  it("derives repo from the git remote when path omits owner/repo", async () => {
    const { deps, runCalls } = makeDeps();
    await resolveGithubView("/cwd", parseGithubPath("gh-issue://7")!, deps);
    const viewCall = runCalls.find((a) => a[0] === "issue" && a[1] === "view");
    expect(viewCall).toContain("github.com/octo/repo");
  });

  it("canonicalizes an SSH-alias remote host before fetching", async () => {
    const { deps, runCalls } = makeDeps({
      gitRemoteUrl: async () => "git@github.com-zshen_adobe:acme/app.git",
      resolveHostAlias: async (host) => (host === "github.com-zshen_adobe" ? "github.com" : host),
    });
    await resolveGithubView("/cwd", parseGithubPath("gh-issue://7")!, deps);
    const viewCall = runCalls.find((a) => a[0] === "issue" && a[1] === "view");
    expect(viewCall).toContain("github.com/acme/app");
    expect(viewCall).not.toContain("github.com-zshen_adobe/acme/app");
  });

  it("uses explicit owner/repo and host prefix over the remote", async () => {
    const { deps, runCalls } = makeDeps();
    await resolveGithubView("/cwd", parseGithubPath("gh-pr://ghe.example.com/acme/widget/7")!, deps);
    const viewCall = runCalls.find((a) => a[0] === "pr" && a[1] === "view");
    expect(viewCall).toContain("ghe.example.com/acme/widget");
  });

  it("caches: second read of a merged PR does not re-fetch", async () => {
    const { deps, runCalls } = makeDeps();
    const target = () => parseGithubPath("gh-pr://7")!;
    await resolveGithubView("/cwd", target(), deps);
    const viewsBefore = runCalls.filter((a) => a[0] === "pr" && a[1] === "view").length;
    await resolveGithubView("/cwd", target(), deps);
    const viewsAfter = runCalls.filter((a) => a[0] === "pr" && a[1] === "view").length;
    expect(viewsBefore).toBe(1);
    expect(viewsAfter).toBe(1); // terminal (MERGED) → served from cache
  });

  it("throws an actionable error when repo cannot be determined", async () => {
    const { deps } = makeDeps({ gitRemoteUrl: async () => null });
    await expect(resolveGithubView("/cwd", parseGithubPath("gh-issue://7")!, deps)).rejects.toThrow(
      /Cannot determine a repository/,
    );
  });

  it("materializes a repo file with its real extension and decoded contents", async () => {
    const { deps } = makeDeps();
    const path = await resolveGithubView("/cwd", parseGithubPath("gh://octo/repo/src/a.ts")!, deps);
    expect(path.endsWith(".ts")).toBe(true);
    expect(await readFile(path, "utf8")).toBe("export const a = 1;\n");
  });

  it("caches a full-SHA ref: second read does not re-fetch", async () => {
    const { deps, runCalls } = makeDeps();
    const sha = "a".repeat(40);
    const target = () => parseGithubPath(`gh://octo/repo/src/a.ts?ref=${sha}`)!;
    await resolveGithubView("/cwd", target(), deps);
    await resolveGithubView("/cwd", target(), deps);
    const apiCalls = runCalls.filter((args) => args[0] === "api").length;
    expect(apiCalls).toBe(1);
  });

  it("returns the decoded body of a .json file, not the cache metadata", async () => {
    const { deps } = makeDeps();
    const path = await resolveGithubView("/cwd", parseGithubPath("gh://octo/repo/package.json")!, deps);
    expect(path.endsWith(".json")).toBe(true);
    expect(await readFile(path, "utf8")).toBe('{"ok":true}\n');
  });
  it.each([
    ["gh://facebook/react/src/a.ts", "github.com/facebook/react"],
    ["gh-pr://facebook/react/7", "github.com/facebook/react"],
    ["gh-issue://OCTO/REPO/7", "ghe.example.com/OCTO/REPO"],
    ["gh://octo/repo/src/a.ts", "ghe.example.com/octo/repo"],
    ["gh-pr://7", "ghe.example.com/octo/repo"],
  ])("applies host precedence to %s", async (input, expected) => {
    const authResolve = vi.fn<AuthResolver["resolve"]>(async () => ({ user: "tester", token: "tok" }));
    const { deps } = makeDeps({ gitRemoteUrl: async () => "https://ghe.example.com/octo/repo.git", auth: { resolve: authResolve, hasHost: async () => true } });
    await resolveGithubView("/cwd", parseGithubPath(input)!, deps);
    expect(authResolve.mock.calls[0]).toEqual([...expected.split("/"), undefined]);
  });

  it("memoizes origin and SSH lookup per cwd, including concurrent reads", async () => {
    const git = vi.fn(async () => "git@alias:octo/repo.git");
    const ssh = vi.fn(async () => "ghe.example.com");
    const { deps } = makeDeps({ gitRemoteUrl: git, resolveHostAlias: ssh });
    await Promise.all([7, 8].map((n) => resolveGithubView("/cwd", parseGithubPath(`gh-issue://${n}`)!, deps)));
    expect(git).toHaveBeenCalledTimes(1);
    expect(ssh).toHaveBeenCalledTimes(1);
    await resolveGithubView("/other", parseGithubPath("gh-issue://9")!, deps);
    expect(git).toHaveBeenCalledTimes(2);
    expect(ssh).toHaveBeenCalledTimes(2);
  });

  it.each(["gh-pr://7", "gh-pr://", "gh-pr://7/diff/x", "gh://o/r/a.ts"])("threads the signal to auth and runner for %s", async (input) => {
    const signal = new AbortController().signal;
    const auth = { resolve: vi.fn<AuthResolver["resolve"]>(async () => ({ user: "u", token: "tok" })), hasHost: async () => true };
    const { deps } = makeDeps({ auth });
    const run = vi.fn(deps.run);
    deps.run = run;
    await resolveGithubView("/cwd", parseGithubPath(input)!, deps, signal);
    expect(auth.resolve.mock.calls[0]?.[3]).toBe(signal);
    expect(run.mock.calls.length).toBeGreaterThan(0);
    expect(run.mock.calls.every(([options]) => options.signal === signal)).toBe(true);
  });

});
