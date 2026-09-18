import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GraphHistoryStore } from "../src/graph/history.js";
import { createWorkflowTask } from "../src/graph/task.js";
import { boot, required } from "./workflow-registration.fixture.js";

describe("graph history lifecycle", () => {
  it.each(["reload", "switch", "shutdown"] as const)("suppresses settlement during %s and flushes earlier settlements", async cause => {
    const store = await GraphHistoryStore.load(`lifecycle-${cause}`);
    const settled = createWorkflowTask({ id: "settled", script: "" });
    Object.assign(settled, { status: "completed", endTime: Date.now() });
    store.capture(settled);
    store.disableCapture(cause);
    const aborted = createWorkflowTask({ id: "aborted", script: "" });
    Object.assign(aborted, { status: "killed", endTime: Date.now() });
    aborted.abortController.abort(cause);
    store.capture(aborted);
    // Late successful or failed completions from the old session are suppressed too.
    store.capture({ ...settled, id: "late" });
    await store.flush();
    expect(store.lifecycleAbortCause).toBe(cause);
    expect((await GraphHistoryStore.load(`lifecycle-${cause}`)).runs.map(run => run.id)).toEqual(["settled"]);
  });

  it("retains explicit user stops, not other aborts", async () => {
    const store = await GraphHistoryStore.load("user-stop");
    const stopped = createWorkflowTask({ id: "stopped", script: "" });
    Object.assign(stopped, { status: "killed", endTime: Date.now() });
    store.capture(stopped);
    expect(store.runs).toEqual([]);
    stopped.abortController.abort("user");
    store.capture(stopped);
    expect(store.runs[0]?.status).toBe("killed");
    await store.flush();
  });

  it("captures a registered graph before notification, flushes at switch, and reloads only the exact session", async () => {
    const host = boot({ workflowsEnabled: true });
    await host.lifecycle("session_start");
    const result = await required(host.tools.get("agent_graph")).execute("call", {
      graph: { name: "Reload history", nodes: { node: { type: "agent", agent: "fixture", prompt: "PRIVATE_SENTINEL" } }, edges: [] },
    }, undefined, undefined, host.ctx);
    const id = required(result.details?.taskId);
    await host.notification(id);
    await host.lifecycle("session_before_switch");
    const text = await readFile(join(required(process.env.PI_CODING_AGENT_DIR), "local/parent/graph-history.json"), "utf8");
    expect(text).not.toContain("PRIVATE_SENTINEL");
    expect((await GraphHistoryStore.load("parent")).runs[0]?.id).toBe(id);
    await host.lifecycle("session_start");
    expect((await GraphHistoryStore.load("parent")).runs[0]?.id).toBe(id);
    host.ui.select.mockResolvedValueOnce("Graph runs (1)");
    await required(host.commands.get("agents")).handler("", host.ctx);
    expect(host.ui.select.mock.calls[0][1]).toContain("Graph runs (1)");
    expect(host.ui.custom).toHaveBeenCalledTimes(1);
    host.ctx.sessionManager.getSessionId = () => "fork";
    await host.lifecycle("session_start");
    expect((await GraphHistoryStore.load("fork")).runs).toEqual([]);
    host.ui.select.mockClear();
    await required(host.commands.get("agents")).handler("", host.ctx);
    expect(host.ui.select.mock.calls[0][1]).toContain("Graph runs (0)");
    expect(host.api.appendEntry).not.toHaveBeenCalled();
  });
});
