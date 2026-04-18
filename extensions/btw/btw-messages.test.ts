/**
 * Tests for btw message building — regression guard before clauderock fix.
 *
 * Covers:
 *   - Messages passed to complete() include session context + user question
 *   - Non-standard message roles from buildSessionContext pass through to complete()
 *   - The user's side question is always the last message
 *   - Empty session context produces only the user question message
 *   - request_start debug entry captures message count and estimated bytes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockContext } from "../../test/fixtures/mock-context.js";
import { createMockPi } from "../../test/fixtures/mock-pi.js";

// ---------------------------------------------------------------------------
// Capture what complete() receives — this is the contract boundary
// ---------------------------------------------------------------------------
let capturedArgs: unknown[] = [];
let completeImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  stopReason: "stop",
  content: [{ type: "text", text: "test answer" }],
});

// Controllable return value for buildSessionContext
let sessionMessages: unknown[] = [];

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await import("../../test/stubs/pi-coding-agent.js");
  return {
    ...actual,
    buildSessionContext: () => ({ messages: sessionMessages }),
  };
});
vi.mock("@mariozechner/pi-tui", () => import("../../test/stubs/pi-tui.js"));
vi.mock("@mariozechner/pi-agent-core", () => import("../../test/stubs/pi-agent-core.js"));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: (...args: unknown[]) => {
    capturedArgs = args;
    return completeImpl(...args);
  },
}));

// ---------------------------------------------------------------------------
// Temp dir for session file
// ---------------------------------------------------------------------------
let tempDir = "";
let sessionFile = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "btw-msg-test-"));
  mkdirSync(join(tempDir, ".pi", "sessions"), { recursive: true });
  sessionFile = join(tempDir, ".pi", "sessions", "test-session.jsonl");

  capturedArgs = [];
  sessionMessages = [];
  completeImpl = async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: "test answer" }],
  });

  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  if (tempDir) await rm(tempDir, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx() {
  const base = createMockContext();
  return {
    ...base,
    sessionManager: {
      ...base.sessionManager,
      getSessionFile: () => sessionFile,
      getLeafId: () => "leaf-001",
    },
    model: { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    modelRegistry: {
      ...base.modelRegistry,
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: "sk-test",
        headers: { "x-api-key": "sk-test" },
      }),
    },
  };
}

async function flushAsync(passes = 5) {
  for (let i = 0; i < passes; i++) await Promise.resolve();
}

async function loadBtw() {
  const mod = await import("./index.js");
  const mockPi = createMockPi();
  mod.default(mockPi.pi as never);
  const cmdDef = mockPi.commands.get("btw") as { handler: (args: string, ctx: unknown) => Promise<void> };
  return { mockPi, cmdDef };
}

/** Extract the context (second arg) passed to complete(model, context, options) */
function getCapturedContext(): { systemPrompt: string; messages: unknown[] } {
  return capturedArgs[1] as { systemPrompt: string; messages: unknown[] };
}

function readDebugEntries(): Array<{ data: { event: string; detail?: any } }> {
  if (!existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line))
    .filter((e: any) => e.customType === "btw:debug");
}

// ---------------------------------------------------------------------------
// Tests — message contract with complete()
// ---------------------------------------------------------------------------

describe("btw messages — empty session", () => {
  it("passes only the user question when session has no messages", async () => {
    sessionMessages = [];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("what is 2+2", ctx);
    await flushAsync();

    const context = getCapturedContext();
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({
      role: "user",
      content: "Side question about the current session:\n\nwhat is 2+2",
    });
  });

  it("user question is always the last message", async () => {
    sessionMessages = [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("test question", ctx);
    await flushAsync();

    const context = getCapturedContext();
    const lastMsg = context.messages[context.messages.length - 1] as any;
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("test question");
  });
});

describe("btw messages — standard roles pass through", () => {
  it("user and assistant messages from session are included", async () => {
    sessionMessages = [
      { role: "user", content: "build a web app", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Sure, I'll help" }], timestamp: 2 },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("status", ctx);
    await flushAsync();

    const context = getCapturedContext();
    // 2 session messages + 1 user question = 3
    expect(context.messages).toHaveLength(3);
    expect((context.messages[0] as any).role).toBe("user");
    expect((context.messages[1] as any).role).toBe("assistant");
    expect((context.messages[2] as any).role).toBe("user");
  });

  it("toolCall blocks in assistant messages are converted to text summaries", async () => {
    sessionMessages = [
      { role: "user", content: "run tests", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "pnpm test" } }],
        timestamp: 2,
      },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("did tests pass", ctx);
    await flushAsync();

    const context = getCapturedContext();
    // assistant's toolCall → text block, so assistant still present
    const assistant = context.messages.find((m: any) => m.role === "assistant") as any;
    expect(assistant).toBeDefined();
    const textBlocks = assistant.content.filter((b: any) => b.type === "text");
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].text).toContain("[Tool: bash");
    expect(textBlocks[0].text).toContain("pnpm test");
    // No toolCall blocks remain
    const toolBlocks = assistant.content.filter((b: any) => b.type === "toolCall");
    expect(toolBlocks.length).toBe(0);
  });

  it("toolResult messages are converted to user messages with text summaries", async () => {
    sessionMessages = [
      { role: "user", content: "run tests", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running tests" },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "pnpm test" } },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: "all tests passed" }],
        timestamp: 3,
      },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("did tests pass", ctx);
    await flushAsync();

    const context = getCapturedContext();
    const roles = context.messages.map((m: any) => m.role);
    // toolResult → user, so: user, assistant, user(converted), user(question)
    expect(roles).toEqual(["user", "assistant", "user", "user"]);
    // The converted toolResult should mention the tool name and result
    const convertedResult = context.messages[2] as any;
    expect(convertedResult.content).toContain("bash result");
    expect(convertedResult.content).toContain("all tests passed");
  });

  it("toolResult with isError shows error label", async () => {
    sessionMessages = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: "command not found" }],
        isError: true,
        timestamp: 1,
      },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("what happened", ctx);
    await flushAsync();

    const context = getCapturedContext();
    const converted = context.messages[0] as any;
    expect(converted.role).toBe("user");
    expect(converted.content).toContain("bash error");
    expect(converted.content).toContain("command not found");
  });

  it("assistant message with only toolCalls becomes text-only (no empty messages)", async () => {
    sessionMessages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/index.ts" } },
          { type: "toolCall", id: "tc2", name: "grep", arguments: { pattern: "TODO" } },
        ],
        timestamp: 1,
      },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("status", ctx);
    await flushAsync();

    const context = getCapturedContext();
    // assistant with 2 toolCalls → assistant with 2 text summaries
    const assistant = context.messages[0] as any;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[0].text).toContain("[Tool: read");
    expect(assistant.content[1].text).toContain("[Tool: grep");
  });
});

describe("btw messages — non-standard roles are filtered out", () => {
  /**
   * buildSessionContext returns AgentMessage[] which may include non-standard roles
   * like branchSummary, compactionSummary, bashExecution, custom.
   * btw now filters these to only user/assistant/toolResult before calling complete().
   * This prevents Bedrock "Unknown message role" errors and matches what Anthropic
   * does implicitly (silently skips unknown roles).
   */

  it("branchSummary messages are filtered out", async () => {
    sessionMessages = [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "branchSummary", content: "Summary of previous branch", timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 3 },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("status", ctx);
    await flushAsync();

    const context = getCapturedContext();
    const roles = context.messages.map((m: any) => m.role);
    expect(roles).not.toContain("branchSummary");
    // user + assistant + btw question = 3 (branchSummary filtered)
    expect(context.messages).toHaveLength(3);
  });

  it("compactionSummary messages are filtered out", async () => {
    sessionMessages = [
      { role: "compactionSummary", content: "Compacted conversation summary", timestamp: 1 },
      { role: "user", content: "continue", timestamp: 2 },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("what happened", ctx);
    await flushAsync();

    const context = getCapturedContext();
    const roles = context.messages.map((m: any) => m.role);
    expect(roles).not.toContain("compactionSummary");
    // user + btw question = 2 (compactionSummary filtered)
    expect(context.messages).toHaveLength(2);
  });

  it("bashExecution messages are filtered out", async () => {
    sessionMessages = [
      { role: "user", content: "run it", timestamp: 1 },
      {
        role: "bashExecution",
        command: "ls -la",
        output: "total 42\ndrwxr-xr-x ...",
        exitCode: 0,
        timestamp: 2,
      },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("what files are there", ctx);
    await flushAsync();

    const context = getCapturedContext();
    const roles = context.messages.map((m: any) => m.role);
    expect(roles).not.toContain("bashExecution");
    // user + btw question = 2 (bashExecution filtered)
    expect(context.messages).toHaveLength(2);
  });

  it("custom role messages are filtered out", async () => {
    sessionMessages = [
      { role: "custom", customType: "some-extension", content: "custom data", timestamp: 1 },
      { role: "user", content: "hi", timestamp: 2 },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("explain", ctx);
    await flushAsync();

    const context = getCapturedContext();
    const roles = context.messages.map((m: any) => m.role);
    expect(roles).not.toContain("custom");
    // user + btw question = 2 (custom filtered)
    expect(context.messages).toHaveLength(2);
  });

  it("mixed roles: non-standard stripped, tools converted to text", async () => {
    sessionMessages = [
      { role: "compactionSummary", content: "Previous context summary", timestamp: 1 },
      { role: "user", content: "build feature", timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "on it" }], timestamp: 3 },
      { role: "bashExecution", command: "npm install", output: "added 100 packages", exitCode: 0, timestamp: 4 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "write", arguments: { path: "foo.ts" } }],
        timestamp: 5,
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "write",
        content: [{ type: "text", text: "written" }],
        timestamp: 6,
      },
      { role: "branchSummary", content: "Branch summary", timestamp: 7 },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("what happened", ctx);
    await flushAsync();

    const context = getCapturedContext();
    const roles = context.messages.map((m: any) => m.role);
    // compactionSummary, bashExecution, branchSummary filtered out
    // toolCall in assistant[1] → text summary, toolResult → user
    // Result: user, assistant(text), assistant(tool summary), user(tool result), user(question)
    expect(context.messages).toHaveLength(5);
    expect(roles).toEqual([
      "user",
      "assistant",
      "assistant",  // was toolCall, now text summary
      "user",       // was toolResult, now user message
      "user",       // btw's side question
    ]);
    // Verify tool summary content
    const toolSummary = context.messages[2] as any;
    expect(toolSummary.content[0].text).toContain("[Tool: write");
    const toolResult = context.messages[3] as any;
    expect(toolResult.content).toContain("write result");
  });
});

describe("btw messages — debug telemetry for messages", () => {
  it("request_start captures messageCount matching actual messages", async () => {
    sessionMessages = [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("test", ctx);
    await flushAsync();

    const start = readDebugEntries().find((e) => e.data.event === "request_start");
    expect(start).toBeDefined();
    // 2 session + 1 question = 3
    expect(start!.data.detail.messageCount).toBe(3);
  });

  it("request_start captures estimatedBytes as positive number", async () => {
    sessionMessages = [
      { role: "user", content: "hello world", timestamp: 1 },
    ];
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("test", ctx);
    await flushAsync();

    const start = readDebugEntries().find((e) => e.data.event === "request_start");
    expect(start).toBeDefined();
    expect(start!.data.detail.estimatedBytes).toBeGreaterThan(0);
  });

  it("request_start captures modelApi field", async () => {
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("test", ctx);
    await flushAsync();

    const start = readDebugEntries().find((e) => e.data.event === "request_start");
    expect(start).toBeDefined();
    expect(start!.data.detail.modelApi).toBe("anthropic-messages");
  });

  it("complete_resolved captures responseModel and responseSnippet", async () => {
    completeImpl = async () => ({
      stopReason: "stop",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "answer" }],
    });
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("test", ctx);
    await flushAsync();

    const resolved = readDebugEntries().find((e) => e.data.event === "complete_resolved");
    expect(resolved).toBeDefined();
    expect(resolved!.data.detail.responseModel).toBe("claude-sonnet-4-6");
    expect(resolved!.data.detail.responseSnippet).toContain("claude-sonnet-4-6");
  });

  it("complete_resolved captures bedrock model ID when fallback occurs", async () => {
    completeImpl = async () => ({
      stopReason: "error",
      model: "us.anthropic.claude-opus-4-6-v1",
      content: [],
      api: "bedrock-converse-stream",
      errorMessage: "Unknown message role",
    });
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("test", ctx);
    await flushAsync();

    const resolved = readDebugEntries().find((e) => e.data.event === "complete_resolved");
    expect(resolved).toBeDefined();
    expect(resolved!.data.detail.responseModel).toBe("us.anthropic.claude-opus-4-6-v1");
    expect(resolved!.data.detail.responseSnippet).toContain("Unknown message role");
    expect(resolved!.data.detail.responseSnippet).toContain("bedrock-converse-stream");
  });
});
