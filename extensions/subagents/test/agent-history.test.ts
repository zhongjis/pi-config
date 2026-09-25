import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHistoryStore, mergeAgentHistory, readHistoryConversation } from "../src/agent-history.js";
import type { AgentRecord } from "../src/types.js";

const SESSION_JSONL = [
  JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp" }),
  JSON.stringify({
    type: "message", id: "m1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "VISIBLE_HISTORY" }], timestamp: 1700000000000 },
  }),
].join("\n") + "\n";

function record(sessionFile: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "Explore",
    description: "review",
    status: "completed",
    toolUses: 2,
    startedAt: 10,
    completedAt: 20,
    lifetimeUsage: { input: 3, output: 4, cacheWrite: 5, cacheRead: 9, cost: 1 },
    compactionCount: 1,
    sessionFile,
    result: "SECRET_RESULT",
    error: "SECRET_ERROR",
    ...overrides,
  };
}

describe("independent agent history", () => {
  let root: string;
  let sessionFile: string;
  const historyPath = (id: string) => join(root, "local", id, "agent-history.json");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-history-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    sessionFile = join(root, "child.jsonl");
    await writeFile(sessionFile, "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("roundtrips capture for the exact session id and isolates another id", async () => {
    const store = await AgentHistoryStore.load("session-a");
    store.capture(record(sessionFile, { id: "older", startedAt: 1, description: "older" }));
    store.capture(record(sessionFile, { id: "newer", startedAt: 2, description: "newer" }));
    store.capture(record(sessionFile, { id: "older", description: "older updated", completedAt: 30 }));
    expect(store.runs.map(run => run.id)).toEqual(["older", "newer"]);
    await store.flush();
    expect((await AgentHistoryStore.load("session-a")).runs).toEqual(store.runs);
    expect((await AgentHistoryStore.load("session-b")).runs).toEqual([]);
    const text = await readFile(historyPath("session-a"), "utf8");
    expect(JSON.parse(text).version).toBe(1);
    expect(text).not.toContain("SECRET_");
    expect(text).not.toContain("cacheRead");
  });

  it("reloads interrupted running and queued rows as stopped without rewriting the file", async () => {
    const stamp = new Date("2024-06-01T12:00:00.000Z");
    await utimes(sessionFile, stamp, stamp);
    const store = await AgentHistoryStore.load("session-a");
    store.capture(record(sessionFile, { id: "live", status: "running", completedAt: undefined, startedAt: 5 }));
    await store.flush();
    const before = await readFile(historyPath("session-a"), "utf8");
    const reloaded = await AgentHistoryStore.load("session-a");
    expect(reloaded.runs[0]).toMatchObject({
      id: "live", status: "stopped", completedAt: (await stat(sessionFile)).mtimeMs,
    });
    expect(await readFile(historyPath("session-a"), "utf8")).toBe(before);

    const missing = join(root, "missing.jsonl");
    await writeFile(historyPath("session-a"), JSON.stringify({
      version: 1,
      runs: [
        { id: "gone", type: "Explore", description: "gone", status: "running", startedAt: 42, toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, sessionFile: missing },
        { id: "queued", type: "Explore", description: "queued", status: "queued", startedAt: 7, toolUses: 1, lifetimeUsage: { input: 1, output: 0, cacheWrite: 0 }, sessionFile: missing },
      ],
    }));
    const interrupted = await AgentHistoryStore.load("session-a");
    expect(interrupted.runs.map(run => [run.id, run.status, run.completedAt])).toEqual([
      ["gone", "stopped", 42],
      ["queued", "stopped", 7],
    ]);
    expect(await readFile(historyPath("session-a"), "utf8")).toContain('"status":"running"');
  });

  it("reloads a terminal row unchanged and drops invalid rows", async () => {
    const store = await AgentHistoryStore.load("session-a");
    store.capture(record(sessionFile, { status: "steered", completedAt: 25 }));
    await store.flush();
    const path = historyPath("session-a");
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.runs.push({ id: "bad", type: "Explore", description: "bad", status: "completed", startedAt: "nope", toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, sessionFile });
    await writeFile(path, JSON.stringify(saved));
    expect((await AgentHistoryStore.load("session-a")).runs).toEqual(store.runs);
  });

  it("keeps 50 newest runs and sanitizes description and type", async () => {
    const store = await AgentHistoryStore.load("session-a");
    for (let index = 0; index < 51; index++) {
      store.capture(record(sessionFile, { id: `id-${index}`, startedAt: index, description: "d".repeat(200), type: `Explore\n\u001b[31m${index}\u001b[0m` }));
    }
    expect(store.runs).toHaveLength(50);
    expect(store.runs[0].id).toBe("id-50");
    expect(store.runs.some(run => run.id === "id-0")).toBe(false);
    expect(store.runs[0].description).toHaveLength(160);
    expect(store.runs[0].type).toBe("Explore 50");
    await store.flush();
    expect(JSON.stringify(await readFile(historyPath("session-a"), "utf8"))).not.toContain("SECRET_");
  });

  it("does not persist prompts, results, or errors", async () => {
    const store = await AgentHistoryStore.load("session-a");
    const value = record(sessionFile);
    Object.assign(value, { prompt: "SECRET_PROMPT", output: "SECRET_OUTPUT" });
    store.capture(value);
    await store.flush();
    const text = await readFile(historyPath("session-a"), "utf8");
    expect(text).not.toContain("SECRET_");
    expect(JSON.stringify((await AgentHistoryStore.load("session-a")).runs)).not.toContain("SECRET_");
  });

  it("disables writes for an unknown version and leaves the file untouched", async () => {
    const path = historyPath("session-a");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "local", "session-a"), { recursive: true });
    const unknown = '{"version":99,"secret":"SECRET_KEEP"}';
    await writeFile(path, unknown);
    const store = await AgentHistoryStore.load("session-a");
    store.capture(record(sessionFile, { id: "new" }));
    await store.flush();
    expect(await readFile(path, "utf8")).toBe(unknown);
    expect(store.runs).toEqual([]);
  });

  it("disableCapture prevents later writes", async () => {
    const store = await AgentHistoryStore.load("session-a");
    store.capture(record(sessionFile, { id: "kept" }));
    store.disableCapture();
    store.capture(record(sessionFile, { id: "late", description: "late" }));
    await store.flush();
    const text = await readFile(historyPath("session-a"), "utf8");
    expect(text).toContain("kept");
    expect(text).not.toContain("late");
  });

  it("ignores graph-owned children and records without a session file", async () => {
    const store = await AgentHistoryStore.load("session-a");
    store.capture(record(sessionFile, { graphRunId: "graph-1" }));
    store.capture(record(sessionFile, { sessionFile: undefined }));
    expect(store.runs).toEqual([]);
    await store.flush();
    await expect(readFile(historyPath("session-a"))).rejects.toThrow();
  });

  it("mergeAgentHistory keeps live records first and projects history without a session", () => {
    const live = record(sessionFile, { id: "live", description: "live copy" });
    const merged = mergeAgentHistory([live], [
      {
        id: "live", type: "Explore", description: "stale", status: "completed", startedAt: 1, completedAt: 2,
        toolUses: 1, lifetimeUsage: { input: 1, output: 1, cacheWrite: 1 }, sessionFile,
      },
      {
        id: "hist", type: "Plan", description: "from disk", status: "stopped", startedAt: 3, completedAt: 4,
        toolUses: 0, lifetimeUsage: { input: 8, output: 9, cacheWrite: 10 }, sessionFile,
      },
    ]);
    expect(merged[0]).toBe(live);
    expect(merged.map(run => run.id)).toEqual(["live", "hist"]);
    expect(merged[1]).not.toHaveProperty("session");
    expect(merged[1].compactionCount).toBe(0);
    expect(merged[1].lifetimeUsage).toEqual({ input: 8, output: 9, cacheWrite: 10 });
    expect(merged[1]).not.toHaveProperty("result");
    expect(merged[1]).not.toHaveProperty("error");
  });

  it("reads a v3 child transcript without writing it, and misses a missing file", async () => {
    const fixture = join(root, "transcript.jsonl");
    await writeFile(fixture, SESSION_JSONL);
    const before = await readFile(fixture);
    const messages = await readHistoryConversation(fixture);
    expect(JSON.stringify(messages)).toContain("VISIBLE_HISTORY");
    expect(await readFile(fixture)).toEqual(before);
    expect(await readHistoryConversation(join(root, "missing.jsonl"))).toBeUndefined();
    expect(await readHistoryConversation(join(root, "bad.jsonl"))).toBeUndefined();
    await writeFile(join(root, "bad.jsonl"), "not-json\n");
    expect(await readHistoryConversation(join(root, "bad.jsonl"))).toBeUndefined();
  });
});
