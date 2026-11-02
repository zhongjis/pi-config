import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { mockSessions, required } from "./graph-run-registration.fixture.js";
import { deferred, flush, type ScriptedSession } from "./helpers/session-seam.js";
import { launchParams, presentationHost, resultText } from "./native-presentation.fixture.js";

async function parkedBackground(host: ReturnType<typeof presentationHost>) {
  const release = deferred();
  const started = deferred<ScriptedSession>();
  mockSessions(async (_prompt, session) => { started.resolve(session); await release.promise; return "background answer"; });
  const launched = await required(host.tools.get("subagent")).execute("launch", { ...launchParams, run_in_background: true }, undefined, undefined, host.context("launch"));
  const id = required(/Agent ID: (\S+)/.exec(resultText(launched))?.[1]);
  return { id, release, session: await started.promise };
}

function finalEntry(host: ReturnType<typeof presentationHost>, id: string, entry: object) {
  const entries = required(host.entries.get(id));
  expect(entries[0]).toMatchObject({ details: { results: [{ finished: false }] } });
  expect(entries.at(-1)).toMatchObject({ details: { results: [{ finished: true, ...entry }] } });
}

describe("registered waiting retrieval presentation", () => {
  it("streams readable progress without cards and preserves final content/details", async () => {
    const host = presentationHost();
    const run = await parkedBackground(host);
    const updates: AgentToolResult<unknown>[] = [];
    try {
      const pending = required(host.tools.get("get_agent_result")).execute("wait", { run_id: run.id, wait: true }, undefined, update => updates.push(update), host.context("wait"));
      expect(updates[0]).toMatchObject({ content: [{ text: expect.stringMatching(/^fixture · test\/chosen · .* · 0 tool uses · /) }] });
      run.release.resolve();
      const result = await pending;
      expect(updates.every(update => !update.details || typeof update.details !== "object" || !("results" in update.details))).toBe(true);
      expect(resultText(result)).toContain("background answer");
      expect(result).toMatchObject({ details: { kind: "agent", run_id: run.id, status: "completed", result: "background answer" } });
      expect(result.details).not.toHaveProperty("results");
    } finally { run.release.resolve(); }
  });

  it.each(["check-in", "abort"])("ends a waiting retrieval at %s without cards or cancelling execution", async (ending) => {
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "1");
    const host = presentationHost();
    const run = await parkedBackground(host);
    const controller = new AbortController();
    try {
      const pending = required(host.tools.get("get_agent_result")).execute("wait", { run_id: run.id, wait: true }, controller.signal, undefined, host.context("wait"));
      if (ending === "check-in") run.session.turn(true);
      else controller.abort("wait cancelled");
      if (ending === "check-in") {
        expect(resultText(await pending)).toContain("pending");
      } else {
        await expect(pending).rejects.toBe("wait cancelled");
      }
      expect(host.entries.has("launch")).toBe(false);
      expect(host.entries.get("wait")?.every(update => !update.details || typeof update.details !== "object" || !("results" in update.details))).toBe(true);
    } finally { run.release.resolve(); await flush(); }
  });

  it.each(["non-wait", "tui", "graph"])("does not present %s retrieval", async (kind) => {
    const host = presentationHost();
    const run = await parkedBackground(host);
    const ctx = host.context("read", kind === "tui" ? "tui" : "rpc");
    const updates: AgentToolResult<unknown>[] = [];
    try {
      const pending = required(host.tools.get("get_agent_result")).execute("read", { run_id: kind === "graph" ? "agr_missing" : run.id, wait: kind !== "non-wait" }, undefined, update => updates.push(update), ctx);
      run.release.resolve();
      if (kind === "graph") await expect(pending).rejects.toThrow("Graph run not found");
      else await pending;
      expect(ctx.executeTool).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    } finally { run.release.resolve(); }
  });

  it.each([false, true])("closes foreground check-in conversion (resume: %s)", async (resume) => {
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "1");
    const host = presentationHost();
    const tool = required(host.tools.get("subagent"));
    let runId: string | undefined;
    const hold = deferred();
    const started = deferred<ScriptedSession>();
    let park = !resume;
    mockSessions(async (_prompt, session) => {
      if (park) { started.resolve(session); await hold.promise; }
      return "answer";
    });
    if (resume) {
      const first = await tool.execute("first", launchParams, undefined, undefined, host.ctx);
      runId = required(/Agent ID: (\S+)/.exec(resultText(first))?.[1]);
      park = true;
    }
    try {
      const pending = tool.execute("convert", { ...launchParams, ...(runId ? { resume: runId } : {}) }, undefined, undefined, host.context("convert"));
      (await started.promise).turn(true);
      const result = await pending;
      const id = required(/Agent ID: (\S+)/.exec(resultText(result))?.[1]);
      finalEntry(host, "convert", { exitCode: 0, messages: [{ content: [{ text: `continues in background as ${id}` }] }] });
      expect(result).toMatchObject({ details: { status: "background" } });
    } finally { hold.resolve(); await flush(); }
  });

  it("throttles activity changes and response tails without spinner updates outside tui", async () => {
    vi.useFakeTimers();
    const host = presentationHost();
    const hold = deferred();
    const started = deferred<ScriptedSession>();
    mockSessions(async (_prompt, session) => { started.resolve(session); await hold.promise; return "done"; });
    const updates: AgentToolResult<unknown>[] = [];
    try {
      const pending = required(host.tools.get("subagent")).execute("progress", launchParams, undefined, update => updates.push(update), host.context("progress"));
      const session = await started.promise;
      session.toolStart("read");
      session.textDelta("latest response");
      await vi.advanceTimersByTimeAsync(999);
      expect(updates).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(updates).toHaveLength(2);
      expect(updates[1]).toMatchObject({ content: [{ text: expect.stringContaining(" · 0 tool uses · reading") }] });
      expect(host.entries.get("progress")?.at(-1)).toMatchObject({ details: { results: [{ finished: false, messages: [{ content: [{ text: "reading…\nlatest response" }] }] }] } });
      await vi.advanceTimersByTimeAsync(3000);
      expect(updates).toHaveLength(2);
      hold.resolve();
      await pending;
    } finally { hold.resolve(); vi.useRealTimers(); }
  });
});
