/**
 * Tests for btw/index.ts — debugLog session entries
 *
 * Covers:
 *   - debugLog writes a well-formed custom entry to the session file
 *   - request_start entry captures model, hasApiKey, headerKeys
 *   - complete_resolved entry reflects isError: false on success
 *   - complete_resolved entry reflects isError: true when complete() returns Error
 *   - error_from_stream entry is written with the actual error message
 *   - empty_response entry is written when response has no text content
 *   - thrown_error entry is written when complete() throws
 *   - debugLog is best-effort: never throws when appendFileSync fails
 *   - No debug entries written when session file path is empty
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockContext } from "../../test/fixtures/mock-context.js";
import { createMockPi } from "../../test/fixtures/mock-pi.js";

// ---------------------------------------------------------------------------
// Controllable complete() mock — configured per test
// ---------------------------------------------------------------------------
let completeImpl: () => Promise<unknown> = async () => ({
  stopReason: "stop",
  content: [{ type: "text", text: "hello world" }],
});

vi.mock("@mariozechner/pi-coding-agent", () => import("../../test/stubs/pi-coding-agent.js"));
vi.mock("@mariozechner/pi-tui", () => import("../../test/stubs/pi-tui.js"));
vi.mock("@mariozechner/pi-agent-core", () => import("../../test/stubs/pi-agent-core.js"));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: (..._args: unknown[]) => completeImpl(),
}));

// ---------------------------------------------------------------------------
// Real temp dir for session file so appendFileSync works end-to-end
// ---------------------------------------------------------------------------
let tempDir = "";
let sessionFile = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "btw-debug-test-"));
  mkdirSync(join(tempDir, ".pi", "sessions"), { recursive: true });
  sessionFile = join(tempDir, ".pi", "sessions", "test-session.jsonl");

  // Default: successful response
  completeImpl = async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: "hello world" }],
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

/** Create a mock context pointing at our temp session file */
function makeCtx() {
  const base = createMockContext();
  return {
    ...base,
    sessionManager: {
      ...base.sessionManager,
      getSessionFile: () => sessionFile,
      getLeafId: () => "leaf-001",
    },
    model: { id: "claude-sonnet-4-6", provider: "anthropic" },
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

/** Parse all btw:debug entries written to the session file */
function readDebugEntries(): Array<{ type: string; customType: string; id: string; parentId: string | null; timestamp: string; data: { event: string; detail?: unknown } }> {
  const { readFileSync, existsSync } = require("node:fs");
  if (!existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line))
    .filter((e: any) => e.customType === "btw:debug");
}

/** Flush all pending microtasks so the fire-and-forget runBtw resolves */
async function flushAsync(passes = 5) {
  for (let i = 0; i < passes; i++) await Promise.resolve();
}

/** Load btw fresh and return the registered /btw command handler */
async function loadBtw() {
  const mod = await import("./index.js");
  const mockPi = createMockPi();
  mod.default(mockPi.pi as never);
  const cmdDef = mockPi.commands.get("btw") as { handler: (args: string, ctx: unknown) => Promise<void> };
  return { mockPi, cmdDef };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("btw debugLog — entry structure", () => {
  it("entries have correct type, customType, parentId, and timestamp", async () => {
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("test question", ctx);
    await flushAsync();

    const entries = readDebugEntries();
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry.type).toBe("custom");
      expect(entry.customType).toBe("btw:debug");
      expect(typeof entry.id).toBe("string");
      expect(entry.parentId).toBe("leaf-001");
      expect(typeof entry.timestamp).toBe("string");
      expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
      expect(typeof entry.data.event).toBe("string");
    }
  });

  it("entries are valid JSON lines — one object per line", async () => {
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("test", ctx);
    await flushAsync();

    const { readFileSync, existsSync } = require("node:fs");
    if (!existsSync(sessionFile)) return;
    const lines = readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("btw debugLog — request_start", () => {
  it("writes request_start with question, model, and auth metadata", async () => {
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("what is 2+2", ctx);
    await flushAsync();

    const start = readDebugEntries().find((e) => e.data.event === "request_start");
    expect(start).toBeDefined();
    expect((start!.data.detail as any).question).toBe("what is 2+2");
    expect((start!.data.detail as any).model).toBe("anthropic/claude-sonnet-4-6");
    expect((start!.data.detail as any).hasApiKey).toBe(true);
    expect((start!.data.detail as any).hasHeaders).toBe(true);
    expect((start!.data.detail as any).headerKeys).toContain("x-api-key");
  });

  it("request_start hasApiKey is false when no apiKey returned", async () => {
    const ctx = {
      ...makeCtx(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: undefined, headers: {} }),
      },
    };
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hi", ctx);
    await flushAsync();

    const start = readDebugEntries().find((e) => e.data.event === "request_start");
    expect(start).toBeDefined();
    expect((start!.data.detail as any).hasApiKey).toBe(false);
    expect((start!.data.detail as any).headerKeys).toEqual([]);
  });
});

describe("btw debugLog — complete_resolved", () => {
  it("writes complete_resolved with isError: false on a successful response", async () => {
    completeImpl = async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "the answer is 4" }],
    });

    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("what is 2+2", ctx);
    await flushAsync();

    const resolved = readDebugEntries().find((e) => e.data.event === "complete_resolved");
    expect(resolved).toBeDefined();
    expect((resolved!.data.detail as any).isError).toBe(false);
    expect((resolved!.data.detail as any).errorMessage).toBeUndefined();
    expect((resolved!.data.detail as any).stopReason).toBe("stop");
    expect((resolved!.data.detail as any).contentLength).toBeGreaterThan(0);
  });

  it("writes complete_resolved with isError: true when complete() returns an Error", async () => {
    completeImpl = async () => new Error("rate limited by Anthropic");

    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hi", ctx);
    await flushAsync();

    const resolved = readDebugEntries().find((e) => e.data.event === "complete_resolved");
    expect(resolved).toBeDefined();
    expect((resolved!.data.detail as any).isError).toBe(true);
    expect((resolved!.data.detail as any).errorMessage).toBe("rate limited by Anthropic");
    expect((resolved!.data.detail as any).stopReason).toBeUndefined();
  });
});

describe("btw debugLog — error_from_stream", () => {
  it("writes error_from_stream with the actual error message", async () => {
    completeImpl = async () => new Error("Clauderock fallback failed: 403 Forbidden");

    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hi", ctx);
    await flushAsync();

    const errEntry = readDebugEntries().find((e) => e.data.event === "error_from_stream");
    expect(errEntry).toBeDefined();
    expect((errEntry!.data.detail as any).message).toBe("Clauderock fallback failed: 403 Forbidden");
  });

  it("does not write error_from_stream on a successful response", async () => {
    completeImpl = async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "all good" }],
    });

    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hi", ctx);
    await flushAsync();

    const errEntry = readDebugEntries().find((e) => e.data.event === "error_from_stream");
    expect(errEntry).toBeUndefined();
  });
});

describe("btw debugLog — empty_response", () => {
  it("writes empty_response when content has no text", async () => {
    completeImpl = async () => ({
      stopReason: "stop",
      content: [],
    });

    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hi", ctx);
    await flushAsync();

    const emptyEntry = readDebugEntries().find((e) => e.data.event === "empty_response");
    expect(emptyEntry).toBeDefined();
    expect((emptyEntry!.data.detail as any).stopReason).toBe("stop");
  });

  it("does not write empty_response when response has text", async () => {
    completeImpl = async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "non-empty" }],
    });

    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hi", ctx);
    await flushAsync();

    const emptyEntry = readDebugEntries().find((e) => e.data.event === "empty_response");
    expect(emptyEntry).toBeUndefined();
  });
});

describe("btw debugLog — thrown_error", () => {
  it("writes thrown_error when complete() throws", async () => {
    completeImpl = async () => {
      throw new Error("unexpected network failure");
    };

    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hi", ctx);
    await flushAsync();

    const thrownEntry = readDebugEntries().find((e) => e.data.event === "thrown_error");
    expect(thrownEntry).toBeDefined();
    expect((thrownEntry!.data.detail as any).message).toBe("unexpected network failure");
    expect(typeof (thrownEntry!.data.detail as any).stack).toBe("string");
  });
});

describe("btw debugLog — resilience", () => {
  it("does not throw when session file is not writable", async () => {
    // Point session file at an unwritable path (directory instead of file)
    mkdirSync(sessionFile, { recursive: true });

    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    // Should not throw even though appendFileSync will fail
    await expect(cmdDef.handler("hi", ctx)).resolves.toBeUndefined();
    await flushAsync();
  });

  it("does not write entries when getSessionFile returns empty string", async () => {
    const ctx = {
      ...makeCtx(),
      sessionManager: {
        getSessionFile: () => "",
        getLeafId: () => "leaf-001",
        getBranch: () => [],
        getEntries: () => [],
      },
    };
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hi", ctx);
    await flushAsync();

    // No file was created at the empty path
    const entries = readDebugEntries();
    expect(entries).toEqual([]);
  });
});

describe("btw debugLog — event ordering", () => {
  it("request_start appears before complete_resolved", async () => {
    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hello", ctx);
    await flushAsync();

    const entries = readDebugEntries();
    const startIdx = entries.findIndex((e) => e.data.event === "request_start");
    const resolvedIdx = entries.findIndex((e) => e.data.event === "complete_resolved");

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(resolvedIdx).toBeGreaterThan(startIdx);
  });

  it("error_from_stream appears after complete_resolved", async () => {
    completeImpl = async () => new Error("boom");

    const ctx = makeCtx();
    const { cmdDef } = await loadBtw();

    await cmdDef.handler("hello", ctx);
    await flushAsync();

    const entries = readDebugEntries();
    const resolvedIdx = entries.findIndex((e) => e.data.event === "complete_resolved");
    const errIdx = entries.findIndex((e) => e.data.event === "error_from_stream");

    expect(resolvedIdx).toBeGreaterThanOrEqual(0);
    expect(errIdx).toBeGreaterThan(resolvedIdx);
  });
});
