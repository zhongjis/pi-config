import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockSessionLocalRoot = "";

vi.mock("../storage.js", () => ({
  LOCAL_URI_PREFIX: "local://",
  isLocalPathTarget: (target: string) => target.startsWith("local://"),
  isLocalRootTarget: (target: string) => target === "local://" || /^local:\/\/+$/u.test(target),
  ensureSessionLocalRootDirectory: async (ctx: { sessionManager: { getSessionId(): string; getBranch(): unknown[] } }) => {
    const sessionRoot = join(mockSessionLocalRoot, ctx.sessionManager.getSessionId());
    await mkdir(sessionRoot, { recursive: true });
    return sessionRoot;
  },
  getSessionLocalPath: (ctx: { sessionManager: { getSessionId(): string; getBranch(): unknown[] } }, relativePath: string) =>
    join(mockSessionLocalRoot, ctx.sessionManager.getSessionId(), relativePath),
  resolveSessionLocalTarget: async (ctx: { sessionManager: { getSessionId(): string; getBranch(): unknown[] } }, target: string) =>
    join(mockSessionLocalRoot, ctx.sessionManager.getSessionId(), target.slice("local://".length)),
}));

import sessionLocalTools from "../index.js";

type SessionLocalContext = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): unknown[];
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
      getBranch: () => [],
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

    await mkdir(join(mockSessionLocalRoot, "session-1"), { recursive: true });
    await writeFile(join(mockSessionLocalRoot, "session-1", "notes.md"), "hi", "utf8");

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

  it("lists any local:// folder one level deep through a per-call listing file", async () => {
    const mock = createMockPi();
    const ctx = createCtx();
    sessionLocalTools(mock.pi as never);

    const sessionRoot = join(mockSessionLocalRoot, "session-1");
    await mkdir(join(sessionRoot, "notes", "archive"), { recursive: true });
    await writeFile(join(sessionRoot, "notes", "a.md"), "abc", "utf8");
    await writeFile(join(sessionRoot, "notes", "archive", "deep.md"), "x", "utf8");

    const rootEvent = { toolCallId: "read-root-1", toolName: "read", input: { path: "local://" } };
    await mock.fire("tool_call", rootEvent, ctx);
    const rootListing = await readFile(rootEvent.input.path, "utf8");
    expect(rootListing).toContain("`local://notes/`");
    expect(rootListing).not.toContain("a.md");
    await mock.fire("tool_execution_end", { toolCallId: "read-root-1" }, ctx);

    const event = { toolCallId: "read-dir-1", toolName: "read", input: { path: "local://notes" } };
    await mock.fire("tool_call", event, ctx);

    const listingPath = event.input.path;
    expect(listingPath.startsWith(sessionRoot)).toBe(false);
    const listing = await readFile(listingPath, "utf8");
    expect(listing).toContain(`\`${join(sessionRoot, "notes")}\``);
    expect(listing).toContain("`local://notes/archive/`");
    expect(listing).toContain("(3 bytes) · `local://notes/a.md`");
    expect(listing).not.toContain("deep.md");

    const [patch] = await mock.fire(
      "tool_result",
      {
        toolCallId: "read-dir-1",
        toolName: "read",
        input: event.input,
        content: [{ type: "text", text: `Read from ${listingPath}` }],
        details: { path: listingPath },
      },
      ctx,
    );
    expect(patch).toMatchObject({
      content: [{ type: "text", text: "Read from local://notes" }],
      details: { path: "local://notes", targetKind: "directory", directoryPath: join(sessionRoot, "notes"), entryCount: 2 },
    });

    await mock.fire("tool_execution_end", { toolCallId: "read-dir-1" }, ctx);
    await expect(access(listingPath)).rejects.toThrow();
  });

  it("lists a folder when the provider tool-call ID exceeds filename limits", async () => {
    const mock = createMockPi();
    const ctx = createCtx();
    sessionLocalTools(mock.pi as never);
    await mkdir(join(mockSessionLocalRoot, "session-1", "notes"), { recursive: true });

    const event = { toolCallId: `call_${"x".repeat(600)}`, toolName: "read", input: { path: "local://notes/" } };
    await mock.fire("tool_call", event, ctx);

    expect(await readFile(event.input.path, "utf8")).toContain("# local://notes/ · 0 entries");
    await mock.fire("tool_execution_end", { toolCallId: event.toolCallId }, ctx);
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
      reason: 'edit does not support local:// folder targets. Use read path="local://" to list the folder.',
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

  it("blocks read of a missing local:// file with actionable guidance", async () => {
    const mock = createMockPi();
    const ctx = createCtx();
    sessionLocalTools(mock.pi as never);

    const event = {
      toolCallId: "read-missing-1",
      toolName: "read",
      input: { path: "local://missing.md" },
    };

    const [result] = await mock.fire("tool_call", event, ctx);

    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("shared by parent and descendant Agents");
    // input untouched — the read never proceeds
    expect(event.input.path).toBe("local://missing.md");
  });

  it("sets the session_local prompt section without returning a systemPrompt", async () => {
    const mock = createMockPi();
    sessionLocalTools(mock.pi as never);
    const sections: Record<string, string> = { existing: "keep" };

    const results = await mock.fire(
      "before_agent_start",
      { type: "before_agent_start", prompt: "", systemPrompt: "Base", systemPromptOptions: { sections } },
      createCtx(),
    );

    expect(results).toEqual([undefined]);
    expect(Object.keys(sections).sort()).toEqual(["existing", "session_local"]);
    expect(sections.session_local.length).toBeGreaterThan(0);
    expect(sections.existing).toBe("keep");
  });
});
