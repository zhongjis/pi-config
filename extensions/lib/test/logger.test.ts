import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockContext } from "../../../test/fixtures/mock-context.js";

vi.mock("@mariozechner/pi-coding-agent", () => import("../../../test/stubs/pi-coding-agent.js"));

let tempDir = "";
let sessionFile = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "panda-lib-logger-test-"));
  mkdirSync(join(tempDir, ".pi", "sessions"), { recursive: true });
  sessionFile = join(tempDir, ".pi", "sessions", "test-session.jsonl");

  vi.resetModules();
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { force: true, recursive: true });
  // Clean up env var
  delete process.env.PANDA_DEBUG;
});

function makeCtx() {
  const base = createMockContext();
  return {
    ...base,
    sessionManager: {
      ...base.sessionManager,
      getSessionFile: () => sessionFile,
      getLeafId: () => "leaf-test",
    },
  };
}

function readDebugEntries() {
  if (!existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e: { customType?: string }) => e.customType === "panda:debug");
}

// ---------------------------------------------------------------------------
// createLogger — debug off
// ---------------------------------------------------------------------------

describe("createLogger — debug off by default", () => {
  it("does not write JSONL entries when debug is inactive", async () => {
    const { createLogger, setGlobalDebug } = await import("../logger.js");
    setGlobalDebug(false);

    const ctx = makeCtx();
    const log = createLogger(ctx, "test-ns");
    log.debug("some_event", { data: 1 });

    const entries = readDebugEntries();
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createLogger — debug on
// ---------------------------------------------------------------------------

describe("createLogger — debug on", () => {
  it("writes a panda:debug JSONL entry with correct fields", async () => {
    const { createLogger, setGlobalDebug } = await import("../logger.js");
    setGlobalDebug(true);

    const ctx = makeCtx();
    const log = createLogger(ctx, "myns");
    log.debug("test_event", { key: "value" });

    const entries = readDebugEntries();
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.type).toBe("custom");
    expect(entry.customType).toBe("panda:debug");
    expect(typeof entry.id).toBe("string");
    expect(entry.parentId).toBe("leaf-test");
    expect(typeof entry.timestamp).toBe("string");
    expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
    expect(entry.data.namespace).toBe("myns");
    expect(entry.data.event).toBe("test_event");
    expect(entry.data.detail).toEqual({ key: "value" });
  });

  it("does not include detail key when data is undefined", async () => {
    const { createLogger, setGlobalDebug } = await import("../logger.js");
    setGlobalDebug(true);

    const ctx = makeCtx();
    const log = createLogger(ctx, "ns");
    log.debug("no_data_event");

    const entries = readDebugEntries();
    expect(entries).toHaveLength(1);
    expect("detail" in entries[0].data).toBe(false);
  });

  it("is best-effort — does not throw when session file is not writable", async () => {
    const { createLogger, setGlobalDebug } = await import("../logger.js");
    setGlobalDebug(true);

    // Replace session file path with an unwritable path (directory)
    mkdirSync(sessionFile, { recursive: true });
    const ctx = makeCtx();
    const log = createLogger(ctx, "ns");

    expect(() => log.debug("event")).not.toThrow();
  });

  it("does not write when getSessionFile returns empty string", async () => {
    const { createLogger, setGlobalDebug } = await import("../logger.js");
    setGlobalDebug(true);

    const base = createMockContext();
    const ctx = {
      ...base,
      sessionManager: {
        ...base.sessionManager,
        getSessionFile: () => "",
        getLeafId: () => "leaf",
      },
    };
    const log = createLogger(ctx, "ns");
    log.debug("event");

    const entries = readDebugEntries();
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// initDebugFromEnv
// ---------------------------------------------------------------------------

describe("initDebugFromEnv", () => {
  it("activates all namespaces when PANDA_DEBUG=*", async () => {
    process.env.PANDA_DEBUG = "*";
    const { initDebugFromEnv, setGlobalDebug, createLogger } = await import("../logger.js");
    setGlobalDebug(false); // reset
    initDebugFromEnv();

    const ctx = makeCtx();
    const log = createLogger(ctx, "any-namespace");
    log.debug("test");

    const entries = readDebugEntries();
    expect(entries.length).toBeGreaterThan(0);
  });

  it("activates only listed namespaces when PANDA_DEBUG=ns1,ns2", async () => {
    process.env.PANDA_DEBUG = "active-ns";
    const { initDebugFromEnv, setGlobalDebug, createLogger } = await import("../logger.js");
    setGlobalDebug(false);
    initDebugFromEnv();

    const ctx = makeCtx();
    const activeLog = createLogger(ctx, "active-ns");
    const inactiveLog = createLogger(ctx, "other-ns");

    activeLog.debug("should_write");
    inactiveLog.debug("should_not_write");

    const entries = readDebugEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].data.namespace).toBe("active-ns");
  });
});

// ---------------------------------------------------------------------------
// logger.status and logger.notify
// ---------------------------------------------------------------------------

describe("logger.status", () => {
  it("calls ctx.ui.setStatus with namespace as key", async () => {
    const { createLogger, setGlobalDebug } = await import("../logger.js");
    setGlobalDebug(false);

    const ctx = makeCtx();
    const setStatusSpy = vi.spyOn(ctx.ui, "setStatus");
    const log = createLogger(ctx, "myns");

    log.status("loading…");
    expect(setStatusSpy).toHaveBeenCalledWith("myns", "loading…");

    log.status(undefined);
    expect(setStatusSpy).toHaveBeenCalledWith("myns", undefined);
  });
});

describe("logger.notify", () => {
  it("calls ctx.ui.notify when hasUI", async () => {
    const { createLogger, setGlobalDebug } = await import("../logger.js");
    setGlobalDebug(false);

    const ctx = makeCtx();
    const notifySpy = vi.spyOn(ctx.ui, "notify");
    const log = createLogger(ctx, "ns");

    log.notify("hello", "success");
    expect(notifySpy).toHaveBeenCalledWith("hello", "success");
  });

  it("falls back to console.log when hasUI is false", async () => {
    const { createLogger, setGlobalDebug } = await import("../logger.js");
    setGlobalDebug(false);

    const base = makeCtx();
    const ctx = { ...base, hasUI: false };
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger(ctx, "ns");

    log.notify("hi");
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
