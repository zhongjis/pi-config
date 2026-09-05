import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { ctx, makePi } from "./helpers/boot-extension.js";
import { perfSession } from "./helpers/perf-fixtures.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
import { resumeAgent, runAgent } from "../src/agent-runner.js";

describe("AgentManager — live identity and continuation", () => {
  let manager: AgentManager;
  const pi = makePi().pi;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockReset().mockImplementation(() => new Promise(() => {}));
    vi.mocked(resumeAgent).mockReset().mockResolvedValue({ text: "continued" });
  });

  afterEach(async () => {
    await manager.dispose();
    vi.useRealTimers();
  });

  it.each([
    { isBackground: false, blocking: true, queued: false },
    { isBackground: true, queued: false },
    { isBackground: false, blocking: true, queued: true },
    { isBackground: true, queued: true },
  ])("assigns a name before launch or queue: %j", (options) => {
    manager.setMaxConcurrentForeground(1);
    if (options.queued) manager.spawn(pi, ctx(), "Holder", "hold", { description: "hold", ...options });
    const id = manager.spawn(pi, ctx(), "Explore", "inspect", {
      description: "inspect", name: "Auth Audit", ...options,
    });
    expect(manager.getRecord(id)).toMatchObject({
      handle: "explore", alias: "auth-audit", status: options.queued ? "queued" : "running",
    });
    expect(manager.resolveMention("AUTH-AUDIT")).toMatchObject({ kind: "live", record: { id } });
    expect(manager.getRecord("auth-audit")).toBeUndefined();
  });

  it("keeps aliases, type handles and each record's own handle in one namespace", () => {
    const first = manager.spawn(pi, ctx(), "Explore", "one", { description: "one", name: "Explore" });
    const second = manager.spawn(pi, ctx(), "Explore", "two", { description: "two", name: "EXPLORE" });
    const third = manager.spawn(pi, ctx(), "Plan", "three", { description: "three", name: "explore-3" });
    expect(manager.getRecord(first)).toMatchObject({ handle: "explore", alias: "explore-2" });
    expect(manager.getRecord(second)).toMatchObject({ handle: "explore-3", alias: "explore-4" });
    expect(manager.getRecord(third)).toMatchObject({ handle: "plan", alias: "explore-3-2" });
  });

  it("reserves tombstone aliases and preserves reclaimed names over a new name", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: perfSession(), aborted: false, steered: false });
    const { record } = await manager.spawnAndWait(pi, ctx(), "Explore", "one", { description: "one", name: "audit" });
    record.sessionFile = "/sessions/audit.jsonl";
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(manager.resolveMention("audit")).toMatchObject({ kind: "tombstone", entry: { id: record.id } });

    const second = manager.spawn(pi, ctx(), "Plan", "two", { description: "two", name: "audit" });
    expect(manager.getRecord(second)).toMatchObject({ alias: "audit-2" });
    const reclaimed = manager.spawn(pi, ctx(), "Explore", "again", {
      description: "again", name: "different", reclaim: { handle: "explore", alias: "audit" },
    });
    expect(manager.getRecord(reclaimed)).toMatchObject({ handle: "explore", alias: "audit" });
    expect(manager.resolveMention("audit")).toMatchObject({ kind: "live", record: { id: reclaimed } });
  });

  it.each([{ parentAgentId: "parent" }, { workflowId: "workflow" }])(
    "keeps owned children out of the name namespace: %j", (ownership) => {
      const id = manager.spawn(pi, ctx(), "Explore", "child", {
        description: "child", name: "audit", reclaim: { handle: "explore", alias: "audit" }, ...ownership,
      });
      expect(manager.getRecord(id)).toMatchObject({ handle: undefined, alias: undefined });
      expect(manager.resolveMention("audit")).toBeUndefined();
      const top = manager.spawn(pi, ctx(), "Explore", "top", { description: "top", name: "audit" });
      expect(manager.getRecord(top)).toMatchObject({ handle: "explore", alias: "audit" });
    },
  );

  describe.each(["running", "queued"] as const)("%s resume refusal", (status) => {
    it.each([undefined, false, true])("leaves the record untouched for isBackground=%s", async (isBackground) => {
      vi.mocked(runAgent).mockResolvedValueOnce({ responseText: "first", session: perfSession(), aborted: false, steered: false });
      const { id, record } = await manager.spawnAndWait(pi, ctx(), "Explore", "first", { description: "first", name: "audit" });
      if (status === "queued") manager.spawn(pi, ctx(), "Holder", "hold", { description: "hold", isBackground: true });
      vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(() => {}));
      await manager.resume(id, "in flight", undefined, { isBackground: true });
      expect(record.status).toBe(status);
      const snapshot = { ...record };
      const calls = vi.mocked(resumeAgent).mock.calls.length;

      const refused = await manager.resume(id, "duplicate", undefined, { isBackground });

      expect(refused).toBeUndefined();
      expect(record).toEqual(snapshot);
      expect(resumeAgent).toHaveBeenCalledTimes(calls);
    });
  });
});
