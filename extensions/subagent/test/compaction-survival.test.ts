import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleSnapshotInput, type AgentLifecycleSnapshotInput } from "../src/lifecycle/agent-lifecycle-store.js";
import {
  captureSessionFingerprint,
  createLifecycleCheckpointHandle,
} from "../src/lifecycle/compaction-checkpoint.js";
import { PersistentBgAgentRegistry, RESUME_TARGET_ENTRY_TYPE } from "../src/lifecycle/registry-persistence.js";
import { awaitParentCompactionCheckpoint } from "../src/ui-wiring/messages.js";
import type { AgentRecord, ResumeTargetV1 } from "../src/types.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sessionBytes(leafId = "leaf-1"): Buffer {
  return Buffer.from([
    JSON.stringify({ type: "session", version: 3, id: "child-session" }),
    JSON.stringify({ type: "message", id: leafId, parentId: null, message: { role: "assistant", content: [] } }),
    "",
  ].join("\n"));
}

function target(id = "agent-a", status: ResumeTargetV1["state"]["status"] = "running"): ResumeTargetV1 {
  const hash = "a".repeat(64);
  return {
    version: 1, id, generation: 0, revision: 0, parentSessionId: "parent-1",
    sessionFile: `/sessions/${id}.jsonl`, sessionDir: "/sessions", childSessionId: `child-${id}`,
    entryCount: 1, activeLeafId: "leaf-0", sessionSha256: hash, type: "jintong",
    description: "persist lifecycle", cwd: "/repo", isBackground: true, createdAt: 1, updatedAt: 2,
    runtime: {
      piVersion: "1", model: { provider: "p", id: "m", api: "a" }, thinkingLevel: "off",
      promptMode: "replace", isolated: false, inheritContext: false, systemPromptHash: hash,
      resourcePolicyHash: hash, agentConfigHash: hash, extensionIdentities: [], activeToolNames: [],
    },
    state: { status, resultConsumed: false, notified: false, toolUses: 3,
      lifetimeUsage: { input: 1, output: 2, cacheWrite: 3 }, lifetimeCost: 0.5, compactionCount: 0 },
  };
}

function input(snapshot: ResumeTargetV1): AgentLifecycleSnapshotInput {
  return lifecycleSnapshotInput(snapshot);
}

function recordFor(snapshot: ResumeTargetV1, sessionFile: string): AgentRecord {
  return {
    id: snapshot.id, type: snapshot.type, description: snapshot.description, status: "running",
    toolUses: snapshot.state.toolUses, startedAt: snapshot.createdAt, sessionFile, sessionDir: snapshot.sessionDir,
    parentSessionId: snapshot.parentSessionId, isBackground: snapshot.isBackground,
    lifetimeUsage: { ...snapshot.state.lifetimeUsage }, lifetimeCost: snapshot.state.lifetimeCost,
    compactionCount: snapshot.state.compactionCount,
  };
}

describe("store-owned compaction checkpoints", () => {
  let root: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subagent-compaction-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("checkpoints one successful child compaction from one exact byte snapshot", async () => {
    const file = join(root, "child.jsonl");
    const bytes = sessionBytes("leaf-after-compact");
    writeFileSync(file, bytes);
    const appendEntry = vi.fn();
    const registry = new PersistentBgAgentRegistry({ appendEntry });
    const snapshot = target();
    snapshot.sessionFile = file;
    snapshot.sessionDir = root;
    const begun = await registry.getOrCreateLifecycleStore(snapshot.id).initialize(input(snapshot));
    const record = recordFor(snapshot, file);

    const handle = await createLifecycleCheckpointHandle(registry, record, begun.lease, true);
    const [checkpoint] = await registry.checkpointAll([handle]);

    expect(checkpoint).toMatchObject({
      generation: 0, revision: 1, entryCount: 1, activeLeafId: "leaf-after-compact",
      sessionSha256: createHash("sha256").update(bytes).digest("hex"),
      state: { status: "running", compactionCount: 1 },
    });
    expect(appendEntry).toHaveBeenCalledTimes(2);
  });

  it("retries only a transient partial final line for three microtask attempts", async () => {
    const complete = sessionBytes("leaf-complete");
    const partial = complete.subarray(0, complete.length - 4);
    const readBytes = vi.fn()
      .mockReturnValueOnce(partial)
      .mockReturnValueOnce(partial)
      .mockReturnValueOnce(complete);

    await expect(captureSessionFingerprint("ignored", readBytes)).resolves.toMatchObject({
      entryCount: 1, activeLeafId: "leaf-complete",
    });
    expect(readBytes).toHaveBeenCalledTimes(3);
  });

  it("rejects permanent parse faults immediately and exhausted partial-line retries", async () => {
    const malformedMiddle = Buffer.from([
      JSON.stringify({ type: "session", version: 3, id: "child" }),
      "not-json",
      JSON.stringify({ type: "message", id: "leaf" }),
      "",
    ].join("\n"));
    const permanentReader = vi.fn(() => malformedMiddle);
    await expect(captureSessionFingerprint("ignored", permanentReader)).rejects.toThrow("invalid JSONL row");
    expect(permanentReader).toHaveBeenCalledOnce();

    const partial = sessionBytes().subarray(0, sessionBytes().length - 4);
    const partialReader = vi.fn(() => partial);
    await expect(captureSessionFingerprint("ignored", partialReader)).rejects.toThrow("partial JSONL row");
    expect(partialReader).toHaveBeenCalledTimes(3);
  });

  it("snapshots repository handles so later iterable mutation does not add checkpoint work", async () => {
    const appendGate = deferred();
    const appendEntry = vi.fn((_type: string, data?: unknown) => {
      const row = data as ResumeTargetV1;
      if (row.revision === 1) return appendGate.promise;
    });
    const registry = new PersistentBgAgentRegistry({ appendEntry });
    const firstStore = registry.getOrCreateLifecycleStore("agent-a");
    const secondStore = registry.getOrCreateLifecycleStore("agent-b");
    const first = await firstStore.initialize(input(target("agent-a")));
    const second = await secondStore.initialize(input(target("agent-b")));
    const handles = [
      registry.createCheckpointHandle("agent-a", first.lease, { ...input(first.snapshot), updatedAt: 3 }),
    ];

    const pending = registry.checkpointAll(handles);
    handles.push(registry.createCheckpointHandle("agent-b", second.lease, { ...input(second.snapshot), updatedAt: 3 }));
    await Promise.resolve();
    expect(appendEntry).toHaveBeenCalledTimes(3);
    appendGate.resolve();
    await pending;

    expect(firstStore.getSnapshot()?.revision).toBe(1);
    expect(secondStore.getSnapshot()?.revision).toBe(0);
  });

  it("rejects a stale-generation child callback without touching the resumed generation", async () => {
    const file = join(root, "stale.jsonl");
    writeFileSync(file, sessionBytes("old-leaf"));
    const appendEntry = vi.fn();
    const registry = new PersistentBgAgentRegistry({ appendEntry });
    const store = registry.getOrCreateLifecycleStore("agent-a");
    const first = await store.initialize(input(target()));
    const staleHandle = await createLifecycleCheckpointHandle(
      registry, recordFor(first.snapshot, file), first.lease, true,
    );
    const terminal = await store.commitTerminal(first.lease, {
      ...input(first.snapshot), updatedAt: 3, state: { ...first.snapshot.state, status: "completed" },
    });
    const resumed = await store.beginResume({
      ...input(terminal), updatedAt: 4, state: { ...terminal.state, status: "running" },
    });
    const callsBefore = appendEntry.mock.calls.length;

    await expect(registry.checkpointAll([staleHandle])).rejects.toThrow("stale lifecycle lease");
    expect(appendEntry).toHaveBeenCalledTimes(callsBefore);
    expect(store.getSnapshot()).toEqual(resumed.snapshot);
  });

  it("parent checkpoint does not wait for active provider or advisory work", async () => {
    const provider = deferred();
    const advisory = deferred();
    const appendEntry = vi.fn();
    const registry = new PersistentBgAgentRegistry({ appendEntry });
    const store = registry.getOrCreateLifecycleStore("agent-a");
    const begun = await store.initialize(input(target()));
    const checkpoint = registry.checkpointAll([
      registry.createCheckpointHandle("agent-a", begun.lease, { ...input(begun.snapshot), updatedAt: 3 }),
    ]).then((snapshots) => {
      void advisory.promise;
      return snapshots;
    });
    void provider.promise;

    await expect(checkpoint).resolves.toMatchObject([{ revision: 1 }]);
  });

  it("cancels parent compaction on append failure, abort, and the internal five-second ceiling", async () => {
    await expect(awaitParentCompactionCheckpoint(
      () => Promise.reject(new Error("append failed")), new AbortController().signal,
    )).resolves.toEqual({ cancel: true });

    const aborted = new AbortController();
    aborted.abort();
    const abortedCheckpoint = vi.fn(() => Promise.resolve());
    await expect(awaitParentCompactionCheckpoint(abortedCheckpoint, aborted.signal)).resolves.toEqual({ cancel: true });
    expect(abortedCheckpoint).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const never = deferred();
    const timedOut = awaitParentCompactionCheckpoint(() => never.promise, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(timedOut).resolves.toEqual({ cancel: true });
  });

  it("re-emits exact current V1 snapshots and replays the post-compact row", async () => {
    const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
    const appendEntry = vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    });
    const registry = new PersistentBgAgentRegistry({ appendEntry });
    const store = registry.getOrCreateLifecycleStore("agent-a");
    const begun = await store.initialize(input(target()));
    const checkpoint = await store.checkpoint(begun.lease, {
      ...input(begun.snapshot), updatedAt: 3, activeLeafId: "current-leaf", sessionSha256: "b".repeat(64),
    });
    entries.length = 0;

    await registry.reemitAll();

    expect(entries).toEqual([{ type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: checkpoint }]);
    const replayed = new PersistentBgAgentRegistry({ appendEntry: vi.fn() });
    expect(replayed.replay(entries)).toBe(1);
    expect(replayed.getResumeTarget("agent-a")).toEqual(checkpoint);
  });
});
