import { describe, expect, it } from "vitest";

import {
  createAuthResolver,
  type GhRunner,
  type GhRunOptions,
  type GhRunResult,
  ghContents,
  ghList,
  ghPrDiff,
  ghViewSingle,
  listAccounts,
  parseAuthStatus,
} from "../gh.js";

const AUTH_STATUS_SAMPLE = `github.com
  ✓ Logged in to github.com account zhongjis (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_REDACTED
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account zshen_adobe (keyring)
  - Active account: false
  - Git operations protocol: https

git.corp.adobe.com
  X Failed to log in to git.corp.adobe.com account zshen (keyring)
  - Active account: true
  - The token in keyring is invalid.
`;

/** Build a fake runner from a list of matchers. First match wins. */
function fakeRunner(
  handlers: Array<{ when: (o: GhRunOptions) => boolean; result: Partial<GhRunResult> }>,
): { run: GhRunner; calls: GhRunOptions[] } {
  const calls: GhRunOptions[] = [];
  const run: GhRunner = async (options) => {
    calls.push(options);
    const handler = handlers.find((h) => h.when(options));
    return { code: 0, stdout: "", stderr: "", ...(handler?.result ?? {}) };
  };
  return { run, calls };
}

const argsAre = (prefix: string[]) => (o: GhRunOptions) =>
  prefix.every((token, index) => o.args[index] === token);

describe("parseAuthStatus", () => {
  it("keeps valid accounts and drops invalid ones", () => {
    const accounts = parseAuthStatus(AUTH_STATUS_SAMPLE);
    expect(accounts).toEqual([
      { host: "github.com", user: "zhongjis", active: true },
      { host: "github.com", user: "zshen_adobe", active: false },
    ]);
  });

  it("does not misattribute the Active line of a dropped account", () => {
    const accounts = parseAuthStatus(AUTH_STATUS_SAMPLE);
    // enterprise account was invalid → dropped, its "Active: true" ignored
    expect(accounts.some((a) => a.host === "git.corp.adobe.com")).toBe(false);
  });
});

describe("listAccounts", () => {
  it("scans both stdout and stderr", async () => {
    const { run } = fakeRunner([{ when: argsAre(["auth", "status"]), result: { stderr: AUTH_STATUS_SAMPLE } }]);
    const accounts = await listAccounts(run);
    expect(accounts).toHaveLength(2);
  });
});

describe("createAuthResolver", () => {
  function resolverRunner(probeOk: (user: string) => boolean) {
    return fakeRunner([
      { when: argsAre(["auth", "status"]), result: { stdout: AUTH_STATUS_SAMPLE } },
      { when: argsAre(["auth", "token"]), result: { stdout: "tok-for-account\n" } },
      {
        when: argsAre(["api"]),
        // encode which user via token env we passed; simulate per-account access
        result: {},
      },
    ]);
  }

  it("prefers the active account and memoizes", async () => {
    const calls: GhRunOptions[] = [];
    const run: GhRunner = async (o) => {
      calls.push(o);
      if (argsAre(["auth", "status"])(o)) return { code: 0, stdout: AUTH_STATUS_SAMPLE, stderr: "" };
      if (argsAre(["auth", "token"])(o)) {
        const user = o.args[o.args.indexOf("--user") + 1];
        return { code: 0, stdout: `token-${user}`, stderr: "" };
      }
      if (argsAre(["api"])(o)) return { code: 0, stdout: "octo/repo", stderr: "" }; // any account works
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const resolver = createAuthResolver(run);
    const first = await resolver.resolve("github.com", "octo", "repo");
    expect(first.user).toBe("zhongjis"); // active first
    expect(first.token).toBe("token-zhongjis");

    const callsBefore = calls.length;
    const second = await resolver.resolve("github.com", "octo", "repo");
    expect(second).toEqual(first);
    expect(calls.length).toBe(callsBefore); // memoized, no new gh calls
  });

  it("falls through to a second account when the first lacks access", async () => {
    const run: GhRunner = async (o) => {
      if (argsAre(["auth", "status"])(o)) return { code: 0, stdout: AUTH_STATUS_SAMPLE, stderr: "" };
      if (argsAre(["auth", "token"])(o)) {
        const user = o.args[o.args.indexOf("--user") + 1];
        return { code: 0, stdout: `token-${user}`, stderr: "" };
      }
      if (argsAre(["api"])(o)) {
        // Only zshen_adobe's token has access.
        return o.token === "token-zshen_adobe"
          ? { code: 0, stdout: "octo/repo", stderr: "" }
          : { code: 1, stdout: "", stderr: "Not Found" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const resolver = createAuthResolver(run);
    const resolved = await resolver.resolve("github.com", "octo", "repo");
    expect(resolved.user).toBe("zshen_adobe");
  });

  it("throws when no account can access the repo", async () => {
    const run: GhRunner = async (o) => {
      if (argsAre(["auth", "status"])(o)) return { code: 0, stdout: AUTH_STATUS_SAMPLE, stderr: "" };
      if (argsAre(["auth", "token"])(o)) return { code: 0, stdout: "tok", stderr: "" };
      if (argsAre(["api"])(o)) return { code: 1, stdout: "", stderr: "HTTP 404" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const resolver = createAuthResolver(run);
    await expect(resolver.resolve("github.com", "octo", "repo")).rejects.toThrow(/can access octo\/repo/);
  });

  it("throws when no account is logged in to the host", async () => {
    const run: GhRunner = async (o) => {
      if (argsAre(["auth", "status"])(o)) return { code: 0, stdout: AUTH_STATUS_SAMPLE, stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const resolver = createAuthResolver(run);
    await expect(resolver.resolve("git.corp.adobe.com", "o", "r")).rejects.toThrow(/logged in to git.corp.adobe.com/);
  });

  it("re-enumerates once to pick up an account added mid-session", async () => {
    let authStatusCalls = 0;
    const run: GhRunner = async (o) => {
      if (argsAre(["auth", "status"])(o)) {
        authStatusCalls += 1;
        // First enumeration: only github.com. After a mid-session re-auth the
        // enterprise account appears on the second (forced) enumeration.
        const out =
          authStatusCalls === 1
            ? "github.com\n  ✓ Logged in to github.com account zhongjis (keyring)\n  - Active account: true\n"
            : "git.corp.adobe.com\n  ✓ Logged in to git.corp.adobe.com account zshen (keyring)\n  - Active account: true\n";
        return { code: 0, stdout: out, stderr: "" };
      }
      if (argsAre(["auth", "token"])(o)) return { code: 0, stdout: "tok", stderr: "" };
      if (argsAre(["api"])(o)) return { code: 0, stdout: "o/r", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const resolver = createAuthResolver(run);
    const resolved = await resolver.resolve("git.corp.adobe.com", "o", "r");
    expect(resolved.user).toBe("zshen");
    expect(authStatusCalls).toBe(2); // cache busted, re-enumerated once
  });

  // avoid unused-var lint on the helper above
  void resolverRunner;
});

describe("fetch primitives", () => {
  it("ghViewSingle requests comment fields when comments=true and targets host/owner/repo", async () => {
    const { run, calls } = fakeRunner([
      { when: argsAre(["issue", "view"]), result: { stdout: JSON.stringify({ number: 5, title: "hi" }) } },
    ]);
    const json = await ghViewSingle(run, "issue", {
      host: "github.com",
      owner: "o",
      repo: "r",
      number: 5,
      comments: true,
      token: "t",
    });
    expect(json).toMatchObject({ number: 5, title: "hi" });
    const call = calls[0];
    expect(call.args).toContain("-R");
    expect(call.args).toContain("github.com/o/r");
    expect(call.args[call.args.indexOf("--json") + 1]).toContain("comments");
  });

  it("ghViewSingle drops comments field when comments=false", async () => {
    const { run, calls } = fakeRunner([
      { when: argsAre(["pr", "view"]), result: { stdout: "{}" } },
    ]);
    await ghViewSingle(run, "pr", { host: "github.com", owner: "o", repo: "r", number: 1, comments: false, token: "t" });
    expect(calls[0].args[calls[0].args.indexOf("--json") + 1]).not.toContain("comments");
  });

  it("ghList passes state/limit/author/label", async () => {
    const { run, calls } = fakeRunner([{ when: argsAre(["pr", "list"]), result: { stdout: "[]" } }]);
    await ghList(run, "pr", {
      host: "github.com",
      owner: "o",
      repo: "r",
      state: "merged",
      limit: 5,
      author: "octocat",
      label: "bug",
      token: "t",
    });
    const a = calls[0].args;
    expect(a).toEqual(expect.arrayContaining(["--state", "merged", "--limit", "5", "--author", "octocat", "--label", "bug"]));
  });

  it("surfaces gh stderr on failure (no token leak)", async () => {
    const { run } = fakeRunner([{ when: argsAre(["pr", "diff"]), result: { code: 1, stderr: "GraphQL: Could not resolve" } }]);
    await expect(
      ghPrDiff(run, { host: "github.com", owner: "o", repo: "r", number: 9, token: "secret-token" }),
    ).rejects.toThrow(/Could not resolve/);
    await expect(
      ghPrDiff(run, { host: "github.com", owner: "o", repo: "r", number: 9, token: "secret-token" }),
    ).rejects.not.toThrow(/secret-token/);
  });
});

describe("ghContents", () => {
  it("returns a directory listing for an array response", async () => {
    const { run } = fakeRunner([
      {
        when: argsAre(["api"]),
        result: {
          stdout: JSON.stringify([
            { name: "index.ts", path: "src/index.ts", type: "file", size: 12 },
            { name: "sub", path: "src/sub", type: "dir", size: 0 },
          ]),
        },
      },
    ]);
    const res = await ghContents(run, { host: "github.com", owner: "o", repo: "r", path: "src", token: "t" });
    expect(res.kind).toBe("dir");
    if (res.kind === "dir") {
      expect(res.entries).toHaveLength(2);
      expect(res.entries[0]).toMatchObject({ name: "index.ts", type: "file", size: 12 });
    }
  });

  it("decodes a base64 file to text and targets the endpoint with ref + hostname", async () => {
    const { run, calls } = fakeRunner([
      {
        when: argsAre(["api"]),
        result: {
          stdout: JSON.stringify({
            type: "file",
            name: "b.ts",
            path: "a/b.ts",
            size: 5,
            sha: "abc",
            encoding: "base64",
            content: Buffer.from("hello").toString("base64"),
          }),
        },
      },
    ]);
    const res = await ghContents(run, { host: "github.com", owner: "o", repo: "r", path: "a/b.ts", ref: "main", token: "t" });
    expect(res).toMatchObject({ kind: "file", text: "hello", name: "b.ts" });
    expect(calls[0].args[1]).toBe("repos/o/r/contents/a/b.ts?ref=main");
    expect(calls[0].args).toContain("--hostname");
  });

  it("classifies a file with a NUL byte as binary", async () => {
    const { run } = fakeRunner([
      {
        when: argsAre(["api"]),
        result: {
          stdout: JSON.stringify({
            type: "file",
            name: "x.bin",
            path: "x.bin",
            size: 3,
            sha: "def",
            encoding: "base64",
            content: Buffer.from("a\u0000b").toString("base64"),
          }),
        },
      },
    ]);
    const res = await ghContents(run, { host: "github.com", owner: "o", repo: "r", path: "x.bin", token: "t" });
    expect(res.kind).toBe("binary");
  });

  it("classifies a metadata-only large file as too-large", async () => {
    const { run } = fakeRunner([
      {
        when: argsAre(["api"]),
        result: {
          stdout: JSON.stringify({ type: "file", name: "big", path: "big", size: 2_000_000, sha: "s", encoding: "none", content: "" }),
        },
      },
    ]);
    const res = await ghContents(run, { host: "github.com", owner: "o", repo: "r", path: "big", token: "t" });
    expect(res.kind).toBe("too-large");
  });

  it("surfaces gh stderr on failure without leaking the token", async () => {
    const { run } = fakeRunner([{ when: argsAre(["api"]), result: { code: 1, stderr: "HTTP 404: Not Found" } }]);
    await expect(
      ghContents(run, { host: "github.com", owner: "o", repo: "r", path: "missing", token: "secret-token" }),
    ).rejects.toThrow(/404/);
    await expect(
      ghContents(run, { host: "github.com", owner: "o", repo: "r", path: "missing", token: "secret-token" }),
    ).rejects.not.toThrow(/secret-token/);
  });
});
