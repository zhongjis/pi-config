import { access, mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockSessionLocalRoot = "";

vi.mock("../storage.js", () => ({
  LOCAL_URI_PREFIX: "local://",
  isLocalPathTarget: (target: string) => target.startsWith("local://"),
  isLocalListingTarget: (target: string) => target === "local://" || /^local:\/\/+$/u.test(target),
  ensureSessionLocalRootDirectory: async (ctx: { sessionManager: { getSessionId(): string } }) => {
    const sessionRoot = join(mockSessionLocalRoot, ctx.sessionManager.getSessionId());
    await mkdir(sessionRoot, { recursive: true });
    return sessionRoot;
  },
  getSessionLocalPath: (ctx: { sessionManager: { getSessionId(): string } }, relativePath: string) =>
    join(mockSessionLocalRoot, ctx.sessionManager.getSessionId(), relativePath),
  resolveSessionLocalTarget: async (ctx: { sessionManager: { getSessionId(): string } }, target: string) =>
    join(mockSessionLocalRoot, ctx.sessionManager.getSessionId(), target.slice("local://".length)),
}));

import sessionLocalTools from "../index.js";

type SessionLocalContext = {
  sessionManager: {
    getSessionId(): string;
  };
};

type LifecycleHandler = (event: unknown, ctx: SessionLocalContext) => unknown | Promise<unknown>;

function createMockPi() {
  const tools: unknown[] = [];
  const handlers = new Map<string, LifecycleHandler[]>();

  return {
    pi: {
      registerTool(definition: unknown) {
        tools.push(definition);
      },
      on(event: string, handler: LifecycleHandler) {
        const current = handlers.get(event) ?? [];
        current.push(handler);
        handlers.set(event, current);
      },
    },
    tools,
    async fire(event: string, payload: unknown, ctx: SessionLocalContext) {
      const current = handlers.get(event) ?? [];
      const results: unknown[] = [];
      for (const handler of current) {
        results.push(await handler(payload, ctx));
      }
      return results;
    },
  };
}

function createCtx(sessionId = "session-1"): SessionLocalContext {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

describe("session-local extension composition", () => {
  beforeEach(async () => {
    mockSessionLocalRoot = await mkdtemp(join(tmpdir(), "pi-session-local-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (mockSessionLocalRoot) {
      await rm(mockSessionLocalRoot, { recursive: true, force: true });
    }
  });

  it("does not register conflicting read/edit tools", () => {
    const mock = createMockPi();
    sessionLocalTools(mock.pi as never);

    expect(mock.tools).toEqual([]);
  });

  it("rewrites local read paths through tool_call and tool_result", async () => {
    const mock = createMockPi();
    const ctx = createCtx();
    sessionLocalTools(mock.pi as never);

    const event = {
      toolCallId: "read-1",
      toolName: "read",
      input: { path: "local://notes.md" },
    };

    await mock.fire("tool_call", event, ctx);

    const resolvedPath = join(mockSessionLocalRoot, "session-1", "notes.md");
    expect(event.input.path).toBe(resolvedPath);

    const [patch] = await mock.fire(
      "tool_result",
      {
        toolCallId: "read-1",
        toolName: "read",
        input: event.input,
        content: [{ type: "text", text: `Read from ${resolvedPath}` }],
        details: { path: resolvedPath },
      },
      ctx,
    );

    expect(patch).toMatchObject({
      content: [{ type: "text", text: "Read from local://notes.md" }],
      details: {
        path: "local://notes.md",
        localPath: "local://notes.md",
        resolvedPath,
        backingPath: resolvedPath,
        targetKind: "path",
      },
    });
  });

  it("builds local root listing for read local:// and rewrites result details", async () => {
    const mock = createMockPi();
    const ctx = createCtx();
    sessionLocalTools(mock.pi as never);

    const event = {
      toolCallId: "read-root-1",
      toolName: "read",
      input: { path: "local://" },
    };

    await mock.fire("tool_call", event, ctx);

    const listingPath = join(mockSessionLocalRoot, "session-1", ".local-root-listing.md");
    await access(listingPath);
    const listingContent = await readFile(listingPath, "utf8");
    expect(listingContent).toContain("# local://");
    expect(event.input.path).toBe(listingPath);

    const [patch] = await mock.fire(
      "tool_result",
      {
        toolCallId: "read-root-1",
        toolName: "read",
        input: event.input,
        content: [{ type: "text", text: `Read from ${listingPath}` }],
        details: { path: listingPath },
      },
      ctx,
    );

    expect(patch).toMatchObject({
      content: [{ type: "text", text: "Read from local://" }],
      details: {
        path: "local://",
        localPath: "local://",
        resolvedPath: listingPath,
        backingPath: listingPath,
        targetKind: "root",
      },
    });
  });

  it("blocks write/edit root aliases while allowing path rewrite for edit", async () => {
    const mock = createMockPi();
    const ctx = createCtx();
    sessionLocalTools(mock.pi as never);

    const editRootEvent = {
      toolCallId: "edit-root-1",
      toolName: "edit",
      input: { path: "local://" },
    };
    const [blockResult] = await mock.fire("tool_call", editRootEvent, ctx);

    expect(blockResult).toMatchObject({
      block: true,
      reason: 'edit does not support local:// root targets. Use read path="local://" to inspect the session-local root.',
    });

    const editPathEvent = {
      toolCallId: "edit-1",
      toolName: "edit",
      input: { path: "local://notes.md" },
    };
    await mock.fire("tool_call", editPathEvent, ctx);

    const resolvedPath = join(mockSessionLocalRoot, "session-1", "notes.md");
    expect(editPathEvent.input.path).toBe(resolvedPath);

    const [patch] = await mock.fire(
      "tool_result",
      {
        toolCallId: "edit-1",
        toolName: "edit",
        input: editPathEvent.input,
        content: [{ type: "text", text: `Updated ${resolvedPath}` }],
        details: { path: resolvedPath },
      },
      ctx,
    );

    expect(patch).toMatchObject({
      content: [{ type: "text", text: "Updated local://notes.md" }],
      details: {
        path: "local://notes.md",
        localPath: "local://notes.md",
        resolvedPath,
      },
    });
  });
});
