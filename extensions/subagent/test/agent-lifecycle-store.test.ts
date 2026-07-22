import { describe, expect, it, vi } from "vitest";
import {
  AgentLifecycleStore,
  AgentLifecycleTransitionError,
  type AgentLifecycleSnapshotInput,
  RESUME_TARGET_ENTRY_TYPE,
} from "../src/lifecycle/agent-lifecycle-store.js";
import type { ResumeTargetState } from "../src/types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshotInput(
  id: string,
  status: ResumeTargetState["status"] = "running",
  overrides: Partial<AgentLifecycleSnapshotInput> = {},
): AgentLifecycleSnapshotInput {
  return {
    id,
    parentSessionId: "parent-1",
    sessionFile: `/sessions/${id}.jsonl`,
    sessionDir: "/sessions",
    childSessionId: `child-${id}`,
    entryCount: 4,
    activeLeafId: "leaf-1",
    sessionSha256: HASH_A,
    type: "jintong",
    description: "Persist lifecycle",
    cwd: "/repo",
    isBackground: true,
    createdAt: 100,
    updatedAt: 200,
    runtime: {
      piVersion: "1.2.3",
      model: { provider: "provider", id: "model", api: "messages" },
      thinkingLevel: "off",
      promptMode: "replace",
      isolated: false,
      inheritContext: true,
      systemPromptHash: HASH_B,
      resourcePolicyHash: HASH_A,
      agentConfigHash: HASH_B,
      extensionIdentities: [{ name: "ext", contentHash: HASH_A }],
      activeToolNames: ["write", "read", "write"],
    },
    state: {
      status,
      resultConsumed: false,
      notified: false,
      toolUses: 1,
      lifetimeUsage: { input: 2, output: 3, cacheWrite: 4 },
      lifetimeCost: 0.5,
      compactionCount: 0,
    },
    ...overrides,
  };
}

describe("AgentLifecycleStore", () => {
  it("commits a generation 0 revision 0 baseline only after append succeeds", async () => {
    const gate = deferred();
    const appendEntry = vi.fn(() => gate.promise);
    const store = new AgentLifecycleStore("agent-a", { appendEntry });

    const pending = store.initialize(snapshotInput("agent-a"));
    await Promise.resolve();
    expect(appendEntry).toHaveBeenCalledWith(RESUME_TARGET_ENTRY_TYPE, expect.objectContaining({ generation: 0, revision: 0 }));
    expect(store.getSnapshot()).toBeUndefined();

    gate.resolve();
    const initialized = await pending;
    expect(initialized.snapshot).toMatchObject({ id: "agent-a", generation: 0, revision: 0 });
    expect(initialized.snapshot.runtime.activeToolNames).toEqual(["read", "write"]);
    expect(store.getSnapshot()).toEqual(initialized.snapshot);
  });

  it("starts each resume at the next generation and revision 0", async () => {
    const appendEntry = vi.fn();
    const store = new AgentLifecycleStore("agent-a", { appendEntry });
    await store.initialize(snapshotInput("agent-a", "completed"));

    const begun = await store.beginResume(snapshotInput("agent-a", "completed", { updatedAt: 300 }));

    expect(begun.snapshot).toMatchObject({ generation: 1, revision: 0, updatedAt: 300 });
    expect(begun.snapshot.state).toMatchObject({ status: "running", resultConsumed: false, notified: false });
  });

  it("serializes a deferred checkpoint before terminal commit with monotonic revisions", async () => {
    const checkpointGate = deferred();
    const persisted: Array<{ generation: number; revision: number; status: string }> = [];
    const appendEntry = vi.fn((_type: string, data?: unknown) => {
      const target = data as { generation: number; revision: number; state: { status: string } };
      persisted.push({ generation: target.generation, revision: target.revision, status: target.state.status });
      if (target.revision === 1) return checkpointGate.promise;
    });
    const store = new AgentLifecycleStore("agent-a", { appendEntry });
    const { lease } = await store.initialize(snapshotInput("agent-a"));

    const checkpoint = store.checkpoint(lease, snapshotInput("agent-a", "running", {
      updatedAt: 201,
      entryCount: 5,
      activeLeafId: "leaf-2",
      sessionSha256: HASH_B,
      state: { ...snapshotInput("agent-a").state, status: "running", compactionCount: 1 },
    }));
    const terminal = store.commitTerminal(lease, snapshotInput("agent-a", "completed", {
      updatedAt: 202,
      entryCount: 6,
      activeLeafId: "leaf-3",
      sessionSha256: HASH_A,
      state: { ...snapshotInput("agent-a").state, status: "completed", compactionCount: 1 },
    }));

    await Promise.resolve();
    expect(persisted).toEqual([
      { generation: 0, revision: 0, status: "running" },
      { generation: 0, revision: 1, status: "running" },
    ]);
    expect(store.getSnapshot()?.revision).toBe(0);

    checkpointGate.resolve();
    expect((await checkpoint).revision).toBe(1);
    expect((await terminal).revision).toBe(2);
    expect(store.getSnapshot()).toMatchObject({ revision: 2, state: { status: "completed", compactionCount: 1 } });
  });

  it("rejects stale and foreign leases without appending", async () => {
    const appendEntry = vi.fn();
    const store = new AgentLifecycleStore("agent-a", { appendEntry });
    const first = await store.initialize(snapshotInput("agent-a", "completed"));
    const resumed = await store.beginResume(snapshotInput("agent-a"));
    const foreignStore = new AgentLifecycleStore("agent-a", { appendEntry });
    await foreignStore.initialize(snapshotInput("agent-a", "completed"));
    const foreign = await foreignStore.beginResume(snapshotInput("agent-a"));
    const callsBeforeRejectedWrites = appendEntry.mock.calls.length;

    await expect(store.checkpoint(first.lease, snapshotInput("agent-a"))).rejects.toThrow("stale lifecycle lease");
    await expect(store.checkpoint(foreign.lease, snapshotInput("agent-a"))).rejects.toThrow("foreign lifecycle lease");

    expect(appendEntry).toHaveBeenCalledTimes(callsBeforeRejectedWrites);
    expect(store.getSnapshot()).toEqual(resumed.snapshot);
  });

  it("makes duplicate identical terminal commands idempotent and rejects conflicts", async () => {
    const appendEntry = vi.fn();
    const store = new AgentLifecycleStore("agent-a", { appendEntry });
    const { lease } = await store.initialize(snapshotInput("agent-a"));
    const command = snapshotInput("agent-a", "completed", { updatedAt: 250 });

    const terminal = await store.commitTerminal(lease, command);
    const duplicate = await store.commitTerminal(lease, command);
    expect(duplicate).toEqual(terminal);
    expect(appendEntry).toHaveBeenCalledTimes(2);

    await expect(store.commitTerminal(lease, snapshotInput("agent-a", "error", { updatedAt: 251 })))
      .rejects.toBeInstanceOf(AgentLifecycleTransitionError);
    expect(appendEntry).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual(terminal);
  });

  it("increments delivery revisions and keeps cache unchanged on append failure", async () => {
    let failConsumed = true;
    const appendEntry = vi.fn((_type: string, data?: unknown) => {
      const target = data as { state: ResumeTargetState };
      if (failConsumed && target.state.resultConsumed) throw new Error("disk full");
    });
    const store = new AgentLifecycleStore("agent-a", { appendEntry });
    const { lease } = await store.initialize(snapshotInput("agent-a"));
    const terminal = await store.commitTerminal(lease, snapshotInput("agent-a", "completed", { updatedAt: 201 }));

    await expect(store.markConsumed(lease, 202)).rejects.toThrow("disk full");
    expect(store.getSnapshot()).toEqual(terminal);

    failConsumed = false;
    const consumed = await store.markConsumed(lease, 202);
    const notified = await store.markNotified(lease, 203);
    expect(consumed).toMatchObject({ revision: 2, state: { resultConsumed: true, notified: false } });
    expect(notified).toMatchObject({ revision: 3, state: { resultConsumed: true, notified: true } });
  });
});
