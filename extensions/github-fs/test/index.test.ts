import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the effectful factories so importing index.ts never spawns gh/git.
vi.mock("../gh.js", () => ({
  createGhRunner: () => async () => ({ code: 0, stdout: "", stderr: "" }),
  createAuthResolver: () => ({ resolve: async () => ({ user: "u", token: "t" }), hasHost: async (host: string) => host === "ghe.example.com" }),
}));
vi.mock("../cache.js", () => ({
  createCache: () => ({ key: () => "k", get: async () => null, put: async () => "/cache/x.md" }),
  isTerminalState: () => false,
}));

const resolveGithubView = vi.fn(async (..._args: unknown[]) => "/cache/view.md");
vi.mock("../resolve.js", () => ({
  resolveGithubView: (...args: unknown[]) => resolveGithubView(...args),
  createRemoteResolver: () => async () => null,
}));

import githubFsTools, { translateGithubUrl } from "../index.js";

type Ctx = { cwd: string; signal?: AbortSignal };
type Handler = (event: unknown, ctx: Ctx) => unknown | Promise<unknown>;

function createMockPi() {
  const handlers = new Map<string, Handler[]>();
  return {
    pi: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    },
    async fire(event: string, payload: unknown, ctx: Ctx = { cwd: "/repo" }) {
      const list = handlers.get(event) ?? [];
      const results: unknown[] = [];
      for (const handler of list) results.push(await handler(payload, ctx));
      return results;
    },
  };
}

function setup() {
  const mock = createMockPi();
  githubFsTools(mock.pi as never);
  return mock;
}

beforeEach(() => {
  resolveGithubView.mockClear();
  resolveGithubView.mockResolvedValue("/cache/view.md");
});

describe("tool_call — read", () => {
  it("rewrites a gh-pr:// read path to the materialized cache file", async () => {
    const mock = setup();
    const input: Record<string, unknown> = { path: "gh-pr://123" };
    const [result] = await mock.fire("tool_call", { toolCallId: "c1", toolName: "read", input });
    expect(result).toBeUndefined(); // not blocked
    expect(input.path).toBe("/cache/view.md");
    expect(resolveGithubView).toHaveBeenCalledOnce();
  });

  it("ignores non-github read paths", async () => {
    const mock = setup();
    const input: Record<string, unknown> = { path: "src/foo.ts" };
    const [result] = await mock.fire("tool_call", { toolCallId: "c2", toolName: "read", input });
    expect(result).toBeUndefined();
    expect(input.path).toBe("src/foo.ts");
    expect(resolveGithubView).not.toHaveBeenCalled();
  });

  it("blocks a malformed github path with a reason", async () => {
    const mock = setup();
    const [result] = await mock.fire("tool_call", {
      toolCallId: "c3",
      toolName: "read",
      input: { path: "gh-pr://onlyowner" },
    });
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toBeTruthy();
    expect(resolveGithubView).not.toHaveBeenCalled();
  });

  it("blocks when resolution fails", async () => {
    const mock = setup();
    resolveGithubView.mockRejectedValueOnce(new Error("HTTP 404"));
    const [result] = await mock.fire("tool_call", {
      toolCallId: "c4",
      toolName: "read",
      input: { path: "gh-pr://999" },
    });
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("404");
  });
});

describe("tool_call — write/edit are read-only", () => {
  it("blocks write to a github path", async () => {
    const mock = setup();
    const [result] = await mock.fire("tool_call", {
      toolCallId: "w1",
      toolName: "write",
      input: { path: "gh-issue://1" },
    });
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toMatch(/read-only/);
  });

  it("blocks edit to a github path", async () => {
    const mock = setup();
    const [result] = await mock.fire("tool_call", {
      toolCallId: "e1",
      toolName: "edit",
      input: { path: "gh-pr://1" },
    });
    expect(result).toMatchObject({ block: true });
  });
});

describe("tool_call — gh:// content", () => {
  it("rewrites a gh:// file read to the materialized cache file", async () => {
    const mock = setup();
    const input: Record<string, unknown> = { path: "gh://o/r/f.ts" };
    const [result] = await mock.fire("tool_call", { toolCallId: "g1", toolName: "read", input });
    expect(result).toBeUndefined();
    expect(input.path).toBe("/cache/view.md");
    expect(resolveGithubView).toHaveBeenCalledOnce();
  });

  it("preserves native offset/limit without suffix interpretation", async () => {
    const mock = setup();
    const input: Record<string, unknown> = { path: "gh://o/r/f.ts", offset: 10, limit: 11 };
    await mock.fire("tool_call", { toolCallId: "g2", toolName: "read", input });
    expect(input).toEqual({ path: "/cache/view.md", offset: 10, limit: 11 });
  });

  it("blocks write to a gh:// path with a read-only reason", async () => {
    const mock = setup();
    const [result] = await mock.fire("tool_call", {
      toolCallId: "g3",
      toolName: "write",
      input: { path: "gh://o/r/f.ts" },
    });
    expect(result).toMatchObject({ block: true, reason: expect.stringMatching(/read-only/) });
  });
});

describe("tool_result rewrite", () => {
  it("rewrites the cache path back to the virtual path", async () => {
    const mock = setup();
    const input: Record<string, unknown> = { path: "gh-pr://123" };
    await mock.fire("tool_call", { toolCallId: "r1", toolName: "read", input });
    const [patch] = await mock.fire("tool_result", {
      toolCallId: "r1",
      content: [{ type: "text", text: "Contents of /cache/view.md follow" }],
      details: { path: "/cache/view.md", resolvedPath: "/cache/view.md" },
    });
    const typed = patch as { content: Array<{ text: string }>; details: Record<string, unknown> };
    expect(typed.content[0].text).toBe("Contents of gh-pr://123 follow");
    expect(typed.details.path).toBe("gh-pr://123");
    expect(typed.details.backingPath).toBe("/cache/view.md");
  });

  it("ignores results for untracked tool calls", async () => {
    const mock = setup();
    const [patch] = await mock.fire("tool_result", {
      toolCallId: "unknown",
      content: [{ type: "text", text: "x" }],
    });
    expect(patch).toBeUndefined();
  });
});

describe("before_agent_start", () => {
  it("sets the github_fs section without returning a systemPrompt or touching other sections", async () => {
    const mock = setup();
    const sections: Record<string, string> = { existing: "keep" };
    const [patch] = await mock.fire("before_agent_start", { systemPrompt: "BASE", systemPromptOptions: { sections } });
    expect(patch).toBeUndefined();
    expect(Object.keys(sections).sort()).toEqual(["existing", "github_fs"]);
    expect(sections.github_fs.length).toBeGreaterThan(0);
    expect(sections.existing).toBe("keep");
  });

  it("is a no-op when the event lacks systemPromptOptions", async () => {
    const mock = setup();
    const [patch] = await mock.fire("before_agent_start", { systemPrompt: "BASE" });
    expect(patch).toBeUndefined();
  });
});

describe("URL translation", () => {
  it.each([
    ["https://github.com/o/r", "gh://o/r/"],
    ["http://www.github.com/o/r/", "gh://o/r/"],
    ["https://ghe.example.com/o/r", "gh://ghe.example.com/o/r/"],
    ["https://github.com/o/r/blob/main/src/a.ts", "gh://o/r/src/a.ts?ref=main"],
    ["https://github.com/o/r/tree/v1/src", "gh://o/r/src?ref=v1"],
    ["https://raw.githubusercontent.com/o/r/main/src/a.ts", "gh://o/r/src/a.ts?ref=main"],
    ["https://github.com/o/r/pull/7", "gh-pr://o/r/7"],
    ["https://github.com/o/r/pull/7/files", "gh-pr://o/r/7/diff"],
    ["https://github.com/o/r/pull/7/commits", "gh-pr://o/r/7"],
    ["https://github.com/o/r/pull/7/checks", "gh-pr://o/r/7"],
    ["https://github.com/o/r/pull/7.diff", "gh-pr://o/r/7.diff"],
    ["https://ghe.example.com/o/r/issues/7#issuecomment-12", "gh-issue://ghe.example.com/o/r/7"],
    ["https://github.com/o/r/pull/7#pullrequestreview-123", "gh-pr://o/r/7"],
    ["https://github.com/o/r/pull/7/files#discussion_r_123", "gh-pr://o/r/7/diff"],
  ])("canonicalizes %s", async (url, path) => {
    expect(await translateGithubUrl(url, async (host) => host === "ghe.example.com")).toEqual({ path });
  });

  it.each(["https://example.com/o/r", "https://github.com/o/r/actions", "https://github.com/o/r/commit/abc", "https://github.com/o/r/pull/7/unknown"])("leaves unsupported URLs native: %s", async (url) => {
    const input = { path: url };
    expect((await setup().fire("tool_call", { toolCallId: "url", toolName: "read", input }))[0]).toBeUndefined();
    expect(input.path).toBe(url);
    expect(resolveGithubView).not.toHaveBeenCalled();
  });

  it.each([["#L600-L760", 600, 161], ["#L600", 600, 1]])("maps %s to native paging", async (fragment, offset, limit) => {
    const input: Record<string, unknown> = { path: `https://github.com/o/r/blob/main/f.ts${fragment}` };
    await setup().fire("tool_call", { toolCallId: "lines", toolName: "read", input });
    expect(input).toEqual({ path: "/cache/view.md", offset, limit });
  });

  it.each([{ offset: 2 }, { limit: 3 }, { offset: 2, limit: 3 }])("preserves caller paging %o", async (paging) => {
    const input = { path: "https://github.com/o/r/blob/main/f.ts#L600-L760", ...paging };
    await setup().fire("tool_call", { toolCallId: "lines", toolName: "read", input });
    expect(input).toEqual({ path: "/cache/view.md", ...paging });
  });

  it("rewrites URL results to the canonical gh path, including structured strings", async () => {
    const mock = setup();
    const signal = new AbortController().signal;
    await mock.fire("tool_call", { toolCallId: "url", toolName: "read", input: { path: "https://github.com/o/r/pull/7" } }, { cwd: "/repo", signal });
    expect(resolveGithubView.mock.calls[0]?.[3]).toBe(signal);
    const structuredContent = { path: "/cache/view.md", nested: ["read /cache/view.md", { n: 1, path: "/cache/view.md" }] };
    const [patch] = await mock.fire("tool_result", { toolCallId: "url", content: [{ type: "text", text: "/cache/view.md" }], structuredContent });
    expect(patch).toMatchObject({ content: [{ text: "gh-pr://o/r/7" }], structuredContent: { path: "gh-pr://o/r/7", nested: ["read gh-pr://o/r/7", { n: 1, path: "gh-pr://o/r/7" }] } });
    expect(structuredContent.path).toBe("/cache/view.md");
  });

  it("omits structuredContent when absent", async () => {
    const mock = setup();
    await mock.fire("tool_call", { toolCallId: "plain", toolName: "read", input: { path: "gh-pr://1" } });
    const [patch] = await mock.fire("tool_result", { toolCallId: "plain", content: [] });
    expect(patch).not.toHaveProperty("structuredContent");
  });

  it.each(["pr://1", "issue://1", "github://o/r"])("does not intercept removed scheme %s", async (path) => {
    const input = { path };
    await setup().fire("tool_call", { toolCallId: "old", toolName: "read", input });
    expect(input.path).toBe(path);
    expect(resolveGithubView).not.toHaveBeenCalled();
  });

  it("does not translate write URLs", async () => {
    const input = { path: "https://github.com/o/r" };
    expect((await setup().fire("tool_call", { toolCallId: "write", toolName: "write", input }))[0]).toBeUndefined();
    expect(input.path).toBe("https://github.com/o/r");
  });
});
