import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import subagentsExtension from "../src/index.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";
import { perfSession } from "./helpers/perf-fixtures.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
import { resumeAgent, runAgent } from "../src/agent-runner.js";

function contentId(result: { content: { text: string }[] }): string {
  const id = /Agent ID: (\S+)/.exec(textOf(result))?.[1];
  if (!id) throw new Error("Tool content omitted Agent ID");
  return id;
}

const policyEntry = {
  type: "custom", customType: "agent-mode",
  data: { mode: "test-mode", delegationPolicy: { version: 1, allowDelegationTo: ["Explore"], disallowDelegationTo: [] } },
};

describe("Agent tools — live ID, handle and alias continuation", () => {
  let home: ReturnType<typeof hermeticDir>;
  let boot: ReturnType<typeof makePi>;
  let context: ReturnType<typeof ctx>;
  let entries: unknown[];
  let spawnSpy: MockInstance<AgentManager["spawn"]>;

  beforeEach(() => {
    home = hermeticDir({ settings: { outputTranscript: false, maxConcurrent: 1 } });
    boot = makePi();
    context = ctx();
    entries = [];
    context.sessionManager.getEntries = () => entries;
    spawnSpy = vi.spyOn(AgentManager.prototype, "spawn");
    vi.mocked(runAgent).mockReset().mockImplementation(async (_ctx, _type, _prompt, options) => {
      const session = { ...perfSession(), steer: vi.fn().mockResolvedValue(undefined) };
      await Promise.resolve();
      options.onSessionCreated?.(session);
      return { responseText: "INITIAL-PAYLOAD", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockReset().mockResolvedValue({ text: "CONTINUED-PAYLOAD" });
    subagentsExtension(boot.pi);
  });

  afterEach(async () => {
    await boot.lifecycle.get("session_shutdown")?.({}, context);
    vi.restoreAllMocks();
    home.restore();
  });

  const call = (params: Record<string, unknown>) => boot.tools.get("Agent").execute(
    "agent-call", { prompt: "continue", description: "Continue work", subagent_type: "general-purpose", run_in_background: false, ...params },
    undefined, undefined, context,
  );

  function manager() {
    const value = spawnSpy.mock.contexts[0];
    if (!(value instanceof AgentManager)) throw new Error("No manager spawned an agent");
    return value;
  }

  async function spawnSettled(name: string, run_in_background = true) {
    const id = contentId(await call({ name, run_in_background }));
    await manager().getRecord(id)?.promise;
    return id;
  }

  describe.each([false, true])("run_in_background=%s", (run_in_background) => {
    it.each([false, true].flatMap(spawnInBackground =>
      ["id", "handle", "alias"].map(reference => ({ spawnInBackground, reference })),
    ))("resumes the correct same-type sibling via $reference (spawn background=$spawnInBackground)", async ({ spawnInBackground, reference }) => {
      const first = await spawnSettled("task-one", spawnInBackground);
      const id = await spawnSettled("task-two", spawnInBackground);
      const record = manager().getRecord(id);
      const session = record?.session;
      const firstSnapshot = { ...manager().getRecord(first) };
      const ref = reference === "id" ? id : reference === "handle" ? "GENERAL-PURPOSE-2" : "TaSk-TwO";

      const resumed = await call({ resume: ref, run_in_background });
      await record?.promise;

      expect(contentId(resumed)).toBe(id);
      expect(resumed.details.agentId).toBe(id);
      expect(resumeAgent).toHaveBeenCalledExactlyOnceWith(session, "continue", expect.any(Object));
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(manager().getRecord(first)).toEqual(firstSnapshot);
      const read = await boot.tools.get("get_subagent_result").execute(
        "read", { agent_id: "TASK-TWO" }, undefined, undefined, context,
      );
      expect(textOf(read)).toContain(`Agent: ${id}`);
      expect(textOf(read)).toContain("CONTINUED-PAYLOAD");
    });

    it.each(["running", "queued"] as const)("refuses %s continuation without mutation", async (status) => {
      const id = await spawnSettled("task-one");
      const record = manager().getRecord(id);
      if (status === "queued") {
        vi.mocked(runAgent).mockImplementationOnce(() => new Promise(() => {}));
        await call({ run_in_background: true });
      }
      if (status === "running") vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(() => {}));
      await call({ resume: id, run_in_background: true });
      expect(record?.status).toBe(status);
      const snapshot = { ...record };
      const calls = vi.mocked(resumeAgent).mock.calls.length;
      boot.pi.events.emit.mockClear();

      const refused = await call({ resume: id, run_in_background });

      expect(textOf(refused)).toContain(`still ${status}`);
      expect(record).toEqual(snapshot);
      expect(resumeAgent).toHaveBeenCalledTimes(calls);
      expect(boot.pi.events.emit).not.toHaveBeenCalled();
    });

    it.each(["id", "handle", "alias"] as const)("rechecks the current mode against stored type via %s", async (reference) => {
      const id = await spawnSettled("task-one");
      const record = manager().getRecord(id);
      const snapshot = { ...record };
      entries.push(policyEntry);
      const ref = reference === "id" ? id : reference === "handle" ? "GENERAL-PURPOSE" : "TASK-ONE";

      const denied = await call({ resume: ref, subagent_type: "Explore", run_in_background });

      expect(denied.details).toMatchObject({ category: "delegation_policy_denied", requestedType: "general-purpose", permittedTypes: ["Explore"] });
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(record).toEqual(snapshot);
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    it.each([{ parentAgentId: "parent" }, { workflowId: "workflow" }])("refuses owned records: %j", async (ownership) => {
      await call({});
      const id = manager().spawn(boot.pi, context, "Explore", "child", { description: "child", name: "private", ...ownership });
      await manager().getRecord(id)?.promise;
      const refused = await call({ resume: id, run_in_background });
      expect(textOf(refused)).toContain("Agent not found");
      expect(resumeAgent).not.toHaveBeenCalled();
    });
  });

  it("steers a named agent through its original session", async () => {
    const id = await spawnSettled("task-one");
    const session = manager().getRecord(id)?.session;
    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(() => {}));
    await call({ resume: id, run_in_background: true });

    await boot.tools.get("steer_subagent").execute("steer", { agent_id: "TaSk-OnE", message: "refocus" }, undefined, undefined, context);

    expect(session?.steer).toHaveBeenCalledWith("refocus");
    expect(boot.pi.events.emit).toHaveBeenCalledWith("subagents:steered", { id, message: "refocus" });
  });

  it("distinguishes unknown and no-session references without spawning", async () => {
    const id = await spawnSettled("task-one");
    const record = manager().getRecord(id);
    if (!record) throw new Error("Missing spawned record");
    record.session = undefined;
    const missingSession = await call({ resume: "TASK-ONE" });
    expect(textOf(missingSession)).toContain("no active session");
    for (const ref of ["missing", "@task-one", "@agent-general-purpose"]) {
      expect(textOf(await call({ resume: ref }))).toContain("Agent not found");
    }
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("does not restore a tombstone when asked to resume", async () => {
    const id = await spawnSettled("task-one");
    const record = manager().getRecord(id);
    if (!record) throw new Error("Missing spawned record");
    record.sessionFile = "/sessions/first.jsonl";
    record.completedAt = 0;
    // Run only the existing GC sweep, retaining its tombstone.
    manager()["cleanup"]();
    expect(manager().resolveMention("task-one")?.kind).toBe("tombstone");
    for (const ref of [id, "general-purpose", "task-one"]) {
      expect(textOf(await call({ resume: ref }))).toContain("Agent not found");
    }
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(resumeAgent).not.toHaveBeenCalled();
  });
});
