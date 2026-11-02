import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dir, mockSessions, openSessionMock, required } from "./graph-run-registration.fixture.js";
import { deferred, flush } from "./helpers/session-seam.js";
import { launchParams, presentationHost, resultText } from "./native-presentation.fixture.js";

function expectClosed(host: ReturnType<typeof presentationHost>, id: string, entry: object) {
  const updates = required(host.entries.get(id));
  expect(updates[0]).toMatchObject({ details: { results: [{ agent: "fixture", task: launchParams.description, step: 0, finished: false }] } });
  expect(updates.at(-1)).toMatchObject({ details: { results: [{ finished: true, ...entry }] } });
}

describe("foreground native cards through registered subagent", () => {
  it.each([false, true])("completes with actual model and preserves the authoritative result (resume: %s)", async (resume) => {
    const host = presentationHost();
    const tool = required(host.tools.get("subagent"));
    mockSessions(() => "THE ANSWER");
    const previous = resume ? await tool.execute("first", launchParams, undefined, undefined, host.ctx) : undefined;
    const id = previous && /Agent ID: (\S+)/.exec(resultText(previous))?.[1];
    const ctx = host.context("run");
    const result = await tool.execute("run", { ...launchParams, ...(id ? { resume: id } : {}) }, undefined, undefined, ctx);
    expectClosed(host, "run", { exitCode: 0, model: "test/chosen", messages: [{ role: "assistant", content: [{ type: "text", text: "THE ANSWER" }] }] });
    expect(ctx.executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ details: { status: "completed", result: "THE ANSWER", modelName: "test/chosen" } });
    expect(result).not.toHaveProperty("isError", true);
    if (resume) expect(resultText(result)).toBe("THE ANSWER");
    else expect(resultText(result)).toMatch(/^Agent ID: \S+\nAgent completed in .*\n\nTHE ANSWER$/);
    expect(result.details).toMatchObject({ results: [{ finished: true, exitCode: 0 }] });
  });

  it.each([false, true])("closes provider failures (resume: %s)", async (resume) => {
    const host = presentationHost();
    const tool = required(host.tools.get("subagent"));
    const previous = resume ? await tool.execute("first", launchParams, undefined, undefined, host.ctx) : undefined;
    const id = previous && /Agent ID: (\S+)/.exec(resultText(previous))?.[1];
    mockSessions(() => ({ failure: "provider unavailable" }));
    // Live resumes retain the original session, so make its next prompt fail too.
    if (id) {
      const session = required(openSessionMock.mock.results[0]);
      const opened = await session.value;
      vi.spyOn(opened.session, "prompt").mockRejectedValueOnce(new Error("provider unavailable"));
    }
    const result = await tool.execute("failure", { ...launchParams, ...(id ? { resume: id } : {}) }, undefined, undefined, host.context("failure"));
    expectClosed(host, "failure", { exitCode: 1, stopReason: "error", errorMessage: "provider unavailable" });
    expect(result).toMatchObject({ isError: true, details: { status: "error" } });
  });

  it.each(["missing", "fixture"]) ("closes policy denial or missing resume: %s", async (type) => {
    const host = presentationHost();
    const result = await required(host.tools.get("subagent")).execute("refused", { ...launchParams, subagent_type: type, ...(type === "fixture" ? { resume: "absent" } : {}) }, undefined, undefined, host.context("refused"));
    const updates = required(host.entries.get("refused"));
    expect(updates[0]).toMatchObject({ details: { results: [{ finished: false }] } });
    expect(updates.at(-1)).toMatchObject({ details: { results: [{ finished: true, exitCode: 1, stopReason: "error", errorMessage: resultText(result) }] } });
  });

  it("closes thrown preparation errors without changing their propagation", async () => {
    const host = presentationHost();
    writeFileSync(join(dir, ".pi", "agents", "fixture.md"), "---\nname: fixture\nmodel: unavailable/model\n---\nTask");
    await expect(required(host.tools.get("subagent")).execute("throw", launchParams, undefined, undefined, host.context("throw"))).rejects.toThrow();
    expectClosed(host, "throw", { exitCode: 1, stopReason: "error", errorMessage: expect.any(String) });
  });

  it.each([false, true])("closes aborted foreground calls with a reason (already aborted: %s)", async (alreadyAborted) => {
    const host = presentationHost();
    const controller = new AbortController();
    mockSessions(async (_prompt, session) => { await session.aborted; return { aborted: true }; });
    if (alreadyAborted) controller.abort("caller cancelled");
    const pending = required(host.tools.get("subagent")).execute("abort", launchParams, controller.signal, undefined, host.context("abort"));
    if (!alreadyAborted) { await flush(); controller.abort("caller cancelled"); }
    await pending;
    expectClosed(host, "abort", { stopReason: "aborted", errorMessage: "cancelled by caller", messages: [{ role: "assistant", content: [{ text: "cancelled by caller" }] }] });
  });

  it.each(["tui", "headless", "background", "queued", "configured-background"] as const)("does not attach native results for %s", async (kind) => {
    const host = presentationHost({ maxConcurrent: 1 });
    if (kind === "configured-background") writeFileSync(join(dir, ".pi", "agents", "fixture.md"), "---\nname: fixture\nrun_in_background: true\n---\nTask");
    const hold = deferred();
    mockSessions(async () => { await hold.promise; return "done"; });
    const ctx = host.context(kind, kind === "tui" ? "tui" : "rpc", kind !== "headless");
    const background = ["background", "queued"].includes(kind);
    try {
      if (kind === "queued") await required(host.tools.get("subagent")).execute("occupy", { ...launchParams, run_in_background: true }, undefined, undefined, ctx);
      const pending = required(host.tools.get("subagent")).execute(kind, { ...launchParams, ...(background ? { run_in_background: true } : {}) }, undefined, undefined, ctx);
      await flush();
      expect(ctx.executeTool).not.toHaveBeenCalled();
      hold.resolve();
      const result = await pending;
      if (kind === "queued") expect(result).toMatchObject({ details: { status: "queued" } });
      expect(result.details).not.toHaveProperty("results");
      expect(host.entries.get(kind)?.some(update => update.details && typeof update.details === "object" && "results" in update.details)).not.toBe(true);
    } finally { hold.resolve(); }
  });

  it.each([false, true])("closes persisted-session resume (refused pointer: %s)", async (refused) => {
    const host = presentationHost();
    const file = join(dir, refused ? "unowned" : "global/subagent-sessions/parent", "child.jsonl");
    const history = join(dir, "global/local/parent/agent-history.json");
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(dirname(history), { recursive: true });
    writeFileSync(file, "synthetic\n");
    writeFileSync(history, JSON.stringify({ version: 1, runs: [{
      id: "evicted", type: "fixture", description: launchParams.description, status: "completed",
      startedAt: 1, completedAt: 2, toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, sessionFile: file,
    }] }));
    await host.lifecycle("session_start");
    mockSessions(() => "RESTORED");
    const result = await required(host.tools.get("subagent")).execute("restore", { ...launchParams, resume: "evicted" }, undefined, undefined, host.context("restore"));
    expectClosed(host, "restore", refused ? { exitCode: 1, stopReason: "error", errorMessage: resultText(result) }
      : { exitCode: 0, messages: [{ content: [{ text: "RESTORED" }] }] });
  });

  it("isolates parallel calls and closes both cards", async () => {
    const host = presentationHost();
    const tool = required(host.tools.get("subagent"));
    await Promise.all(["left", "right"].map(id => tool.execute(id, launchParams, undefined, undefined, host.context(id))));
    for (const id of ["left", "right"]) expectClosed(host, id, { exitCode: 0 });
  });
});
