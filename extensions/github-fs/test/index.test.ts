import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the effectful factories so importing index.ts never spawns gh/git.
vi.mock("../gh.js", () => ({
  createGhRunner: () => async () => ({ code: 0, stdout: "", stderr: "" }),
  createAuthResolver: () => ({ resolve: async () => ({ user: "u", token: "t" }) }),
}));
vi.mock("../cache.js", () => ({
  createCache: () => ({ key: () => "k", get: async () => null, put: async () => "/cache/x.md" }),
  isTerminalState: () => false,
}));

const resolveGithubView = vi.fn(async () => "/cache/view.md");
vi.mock("../resolve.js", () => ({
  resolveGithubView: (...args: unknown[]) => resolveGithubView(...(args as [])),
  parseRemoteUrl: () => null,
}));

import githubFsTools from "../index.js";

type Ctx = { cwd: string };
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
  it("rewrites a pr:// read path to the materialized cache file", async () => {
    const mock = setup();
    const input: Record<string, unknown> = { path: "pr://123" };
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
      input: { path: "pr://onlyowner" },
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
      input: { path: "pr://999" },
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
      input: { path: "issue://1" },
    });
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toMatch(/read-only/);
  });

  it("blocks edit to a github path", async () => {
    const mock = setup();
    const [result] = await mock.fire("tool_call", {
      toolCallId: "e1",
      toolName: "edit",
      input: { path: "pr://1" },
    });
    expect(result).toMatchObject({ block: true });
  });
});

describe("tool_call — github:// content", () => {
  it("rewrites a github:// file read to the materialized cache file", async () => {
    const mock = setup();
    const input: Record<string, unknown> = { path: "github://o/r/f.ts" };
    const [result] = await mock.fire("tool_call", { toolCallId: "g1", toolName: "read", input });
    expect(result).toBeUndefined();
    expect(input.path).toBe("/cache/view.md");
    expect(resolveGithubView).toHaveBeenCalledOnce();
  });

  it("strips the selector to a clean cache path and derives offset/limit", async () => {
    const mock = setup();
    const input: Record<string, unknown> = { path: "github://o/r/f.ts:10-20" };
    const [result] = await mock.fire("tool_call", { toolCallId: "g2", toolName: "read", input });
    expect(result).toBeUndefined();
    expect(input.path).toBe("/cache/view.md"); // clean — selector NOT re-appended
    expect(input.offset).toBe(10);
    expect(input.limit).toBe(11);
    expect(resolveGithubView).toHaveBeenCalledOnce();
  });

  it("blocks write to a github:// path with a read-only reason", async () => {
    const mock = setup();
    const [result] = await mock.fire("tool_call", {
      toolCallId: "g3",
      toolName: "write",
      input: { path: "github://o/r/f.ts" },
    });
    expect(result).toMatchObject({ block: true, reason: expect.stringMatching(/read-only/) });
  });
});

describe("tool_result rewrite", () => {
  it("rewrites the cache path back to the virtual path", async () => {
    const mock = setup();
    const input: Record<string, unknown> = { path: "pr://123" };
    await mock.fire("tool_call", { toolCallId: "r1", toolName: "read", input });
    const [patch] = await mock.fire("tool_result", {
      toolCallId: "r1",
      content: [{ type: "text", text: "Contents of /cache/view.md follow" }],
      details: { path: "/cache/view.md", resolvedPath: "/cache/view.md" },
    });
    const typed = patch as { content: Array<{ text: string }>; details: Record<string, unknown> };
    expect(typed.content[0].text).toBe("Contents of pr://123 follow");
    expect(typed.details.path).toBe("pr://123");
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
  it("appends the path grammar to the system prompt", async () => {
    const mock = setup();
    const [patch] = await mock.fire("before_agent_start", { systemPrompt: "BASE" });
    const typed = patch as { systemPrompt: string };
    expect(typed.systemPrompt.startsWith("BASE")).toBe(true);
    expect(typed.systemPrompt).toContain("GitHub virtual paths");
    expect(typed.systemPrompt).toContain("pr://<n>/diff");
  });
});
