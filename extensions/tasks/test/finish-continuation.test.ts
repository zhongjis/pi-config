import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { readGoalForContext } from "../../goal/src/goal/context.js";
import { GOAL_STATUS_VALUES } from "../../goal/src/goal/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { registerFinishContinuation } from "../src/lifecycle/finish-continuation.js";
import { TaskStore } from "../src/task-store.js";

function testContext() {
  const base = createMockContext();
  const entries: SessionEntry[] = [];
  return { ...base, sessionManager: { ...base.sessionManager, getEntries: () => entries } };
}

function setup() {
  const registrations: [string, unknown][] = [];
  const on: ExtensionAPI["on"] = (name: string, handler: unknown) => { registrations.push([name, handler]); };
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const { events } = createMockPi().pi;
  const subscribe = vi.spyOn(events, "on");
  const ctx = testContext();
  const runtime: { store: TaskStore; taskScope: string; piTasks: string | undefined } =
    { store: new TaskStore(), taskScope: "memory", piTasks: undefined };
  const readGoal = vi.fn<typeof readGoalForContext>(async () => null);
  registerFinishContinuation({ on, events, sendMessage }, runtime, readGoal);
  let sessionStarted = false;

  async function fire(event: ExtensionEvent) {
    if (event.type === "session_start") sessionStarted = true;
    if (event.type === "session_shutdown") sessionStarted = false;
    for (const registration of registrations) {
      // Registration pairs bind each event discriminant to its handler.
      if (matches(registration, event)) await registration[1](event, ctx);
    }
  }
  async function start() {
    if (!sessionStarted) await fire({ type: "session_start", reason: "new" });
    await fire({ type: "input", source: "interactive", text: "Execute the task" });
    await fire({ type: "agent_start" });
  }
  async function enroll(id: string) {
    await fire({ type: "tool_result", toolName: "Task", toolCallId: "task-call", input: { op: "create" },
      content: [], details: { taskIds: [id] }, isError: false });
  }
  async function settle(stopReason: AssistantMessage["stopReason"] = "stop") {
    await fire({ type: "agent_end", messages: [{ role: "assistant", content: [], api: "openai-responses",
      provider: "test", model: "test", timestamp: 1, stopReason,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] });
    await fire({ type: "agent_settled" });
  }
  return { runtime, ctx, events, subscribe, sendMessage, readGoal, fire, start, enroll, settle };
}

function matches<E extends ExtensionEvent>(
  registration: [string, unknown], event: E,
): registration is [E["type"], (event: E, ctx: ReturnType<typeof testContext>) => unknown] {
  return registration[0] === event.type;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("task finish continuation", () => {
  it("subscribes only for active sessions and removes each subscription once", async () => {
    const h = setup();
    expect(h.subscribe).not.toHaveBeenCalled();
    const unsubscribe = vi.fn<() => void>();
    h.subscribe.mockReturnValueOnce(unsubscribe);
    await h.fire({ type: "session_start", reason: "new" });
    await h.fire({ type: "session_start", reason: "resume" });
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.subscribe).toHaveBeenCalledWith("user-prompted", expect.any(Function));
    await h.fire({ type: "session_shutdown", reason: "quit" });
    await h.fire({ type: "session_shutdown", reason: "quit" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await h.fire({ type: "session_start", reason: "resume" });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    await h.fire({ type: "session_shutdown", reason: "quit" });
  });

  it("dispatches exactly once after a clean settled run with enrolled unfinished work", async () => {
    const h = setup();
    await h.start();
    const task = h.runtime.store.create("Implement", "Authorized work");
    await h.enroll(task.id);
    await h.settle();
    await h.fire({ type: "agent_settled" });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ display: false }),
      { triggerTurn: true, deliverAs: "followUp" });
    expect(h.runtime.store.get(task.id)?.status).toBe("pending");
  });

  it("bounds task summary rows and preserves Unicode subjects and statuses", async () => {
    const h = setup();
    await h.start();
    for (let i = 0; i < 12; i++) {
      const task = h.runtime.store.create(i === 1 ? "A\n B" : "😀".repeat(200), "Work");
      if (i === 0) h.runtime.store.update(task.id, { status: "in_progress" });
      await h.enroll(task.id);
    }
    await h.settle();
    const content = h.sendMessage.mock.calls[0]?.[0].content;
    if (typeof content !== "string") throw new Error("Expected text content");
    const rows = content.split("\n").filter(line => line.startsWith("#"));
    expect(rows).toHaveLength(10);
    expect(rows[0]).toBe(`#1 [in_progress] ${"😀".repeat(120)}`);
    expect(rows[1]).toBe("#2 [pending] A B");
    expect(content.length).toBeLessThan(4000);
  });

  it("does not enroll tasks through read-only calls", async () => {
    const h = setup();
    await h.start();
    h.runtime.store.create("Old work", "Not authorized this episode");
    await h.fire({ type: "tool_result", toolName: "Task", toolCallId: "list", input: { op: "list" },
      content: [], details: undefined, isError: false });
    await h.settle();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("stops after stagnation with one visible notice; synthetic input cannot reset it", async () => {
    const h = setup();
    await h.start();
    const task = h.runtime.store.create("Work", "Work");
    await h.enroll(task.id);
    await h.settle();
    await h.fire({ type: "input", source: "extension", text: "follow-up" });
    await h.fire({ type: "agent_start" });
    h.runtime.store.update(task.id, { description: "metadata-only edit" });
    await h.enroll(task.id);
    await h.settle();
    await h.fire({ type: "agent_start" });
    await h.settle();
    expect(h.sendMessage.mock.calls.map(([message]) => message.display)).toEqual([false, true]);
  });

  it("allows a second nudge only for forward status progress and caps at two", async () => {
    const h = setup();
    await h.start();
    const a = h.runtime.store.create("A", "A");
    const b = h.runtime.store.create("B", "B");
    await h.enroll(a.id);
    await h.enroll(b.id);
    await h.settle();
    await h.fire({ type: "agent_start" });
    h.runtime.store.update(a.id, { status: "in_progress" });
    await h.enroll(a.id);
    await h.settle();
    await h.fire({ type: "agent_start" });
    h.runtime.store.update(a.id, { status: "completed" });
    await h.settle();
    await h.fire({ type: "agent_settled" });
    expect(h.sendMessage.mock.calls.map(([message]) => message.display)).toEqual([false, false, true]);
  });

  it.each(["delete", "create", "toggle"])("does not reward %s as forward progress", async (change) => {
    const h = setup();
    await h.start();
    const a = h.runtime.store.create("A", "A");
    const b = h.runtime.store.create("B", "B");
    h.runtime.store.update(a.id, { status: "in_progress" });
    await h.enroll(a.id);
    await h.enroll(b.id);
    await h.settle();
    await h.fire({ type: "agent_start" });
    if (change === "delete") h.runtime.store.delete(a.id);
    if (change === "create") await h.enroll(h.runtime.store.create("C", "C").id);
    if (change === "toggle") {
      h.runtime.store.update(a.id, { status: "pending" });
      await h.enroll(a.id);
      h.runtime.store.update(a.id, { status: "in_progress" });
      await h.enroll(a.id);
    }
    await h.settle();
    expect(h.sendMessage.mock.calls.map(([message]) => message.display)).toEqual([false, true]);
  });

  it.each(["session", "memory", "off"])("supports local scope %s", async (scope) => {
    const h = setup();
    h.runtime.taskScope = scope === "off" ? "project" : scope;
    h.runtime.piTasks = scope === "off" ? "off" : undefined;
    await h.start();
    await h.enroll(h.runtime.store.create("A", "A").id);
    await h.settle();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["project", "named", "/shared/tasks.json", "./tasks.json"])("excludes shared scope %s", async (scope) => {
    const h = setup();
    if (scope === "project") h.runtime.taskScope = scope;
    else h.runtime.piTasks = scope;
    await h.start();
    await h.enroll(h.runtime.store.create("A", "A").id);
    await h.settle();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["owned", "planning", "completed"])("excludes %s tasks", async (kind) => {
    const h = setup();
    await h.start();
    const task = h.runtime.store.create("A", "A", undefined,
      kind === "planning" ? { _piWorkflowPhase: "planning" } : undefined);
    if (kind === "owned") h.runtime.store.update(task.id, { owner: "ambiguous-owner" });
    if (kind === "completed") h.runtime.store.update(task.id, { status: "completed" });
    await h.enroll(task.id);
    await h.settle();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["aborted", "error", "length", "toolUse"] satisfies AssistantMessage["stopReason"][])(
    "suppresses unclean stop %s", async (reason) => {
      const h = setup();
      await h.start();
      await h.enroll(h.runtime.store.create("A", "A").id);
      await h.settle(reason);
      expect(h.sendMessage).not.toHaveBeenCalled();
    });

  it.each(GOAL_STATUS_VALUES)("defers to an existing %s Goal", async (status) => {
    const h = setup();
    h.readGoal.mockResolvedValue({ id: "goal", threadId: "thread", objective: "Goal", status,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 });
    await h.start();
    await h.enroll(h.runtime.store.create("A", "A").id);
    await h.settle();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("fails closed on Goal lookup errors", async () => {
    const h = setup();
    h.readGoal.mockRejectedValue(new Error("unreadable"));
    await h.start();
    await h.enroll(h.runtime.store.create("A", "A").id);
    await h.settle();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["child", "fuxi", "review", "awaiting", "prompted", "workers", "process", "interactive_shell"] )(
    "suppresses %s waits/authority boundaries", async (guard) => {
      const h = setup();
      await h.start();
      await h.enroll(h.runtime.store.create("A", "A").id);
      if (guard === "child") h.ctx.getSystemPrompt = () => '<active_agent name="juling"/>';
      if (["fuxi", "review", "awaiting"].includes(guard)) {
        h.ctx.sessionManager.getEntries().push({ type: "custom", customType: "agent-mode",
          id: "mode", parentId: null, timestamp: "now", data: { mode: guard === "fuxi" ? "fuxi" : "wukong",
            planReviewPending: guard === "review", awaitingUserAction: { suppressContinuationReminder: guard === "awaiting" } } });
      }
      if (guard === "prompted") h.events.emit("user-prompted", { tool: "ask" });
      if (guard === "workers") vi.stubGlobal(Symbol.for("pi-subagents:manager"), { hasRunning: () => true });
      if (guard === "process" || guard === "interactive_shell") {
        await h.fire({ type: "tool_execution_start", toolName: guard, toolCallId: "wait", args: {} });
      }
      await h.settle();
      expect(h.sendMessage).not.toHaveBeenCalled();
    });

  it("uses only the latest mode entry and fails closed on invalid worker accessors", async () => {
    const h = setup();
    await h.start();
    await h.enroll(h.runtime.store.create("A", "A").id);
    h.ctx.sessionManager.getEntries().push(
      { type: "custom", customType: "agent-mode", id: "old", parentId: null, timestamp: "now", data: { planReviewPending: true } },
      { type: "custom", customType: "agent-mode", id: "new", parentId: "old", timestamp: "now", data: { mode: "wukong" } });
    vi.stubGlobal(Symbol.for("pi-subagents:manager"), { hasRunning: () => false });
    await h.settle();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    await h.fire({ type: "agent_start" });
    vi.stubGlobal(Symbol.for("pi-subagents:manager"), { hasRunning: () => { throw new Error("stale"); } });
    await h.settle();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["input", "session", "tree", "shutdown", "run", "busy", "pending", "owner", "complete", "store", "prompted", "worker", "child", "mode"])(
    "rechecks %s changes across asynchronous Goal reads", async (race) => {
      const h = setup();
      await h.start();
      const task = h.runtime.store.create("A", "A");
      await h.enroll(task.id);
      let release: () => void = () => { throw new Error("Goal read not started"); };
      const gate = new Promise<null>(resolve => { release = () => resolve(null); });
      h.readGoal.mockReturnValue(gate);
      const settling = h.settle();
      await vi.waitFor(() => expect(h.readGoal).toHaveBeenCalledTimes(1));
      if (race === "input") await h.fire({ type: "input", source: "rpc", text: "Stop" });
      if (race === "session") h.ctx.sessionManager.getSessionId = () => "new-session";
      if (race === "tree") await h.fire({ type: "session_tree", newLeafId: "new", oldLeafId: "old" });
      if (race === "shutdown") await h.fire({ type: "session_shutdown", reason: "quit" });
      if (race === "run") await h.fire({ type: "agent_start" });
      if (race === "busy") h.ctx.isIdle = () => false;
      if (race === "pending") h.ctx.hasPendingMessages = () => true;
      if (race === "owner") h.runtime.store.update(task.id, { owner: "worker" });
      if (race === "complete") h.runtime.store.update(task.id, { status: "completed" });
      if (race === "store") h.runtime.store = new TaskStore();
      if (race === "prompted") h.events.emit("user-prompted", { tool: "ask" });
      if (race === "worker") vi.stubGlobal(Symbol.for("pi-subagents:manager"), { hasRunning: () => true });
      if (race === "child") h.ctx.getSystemPrompt = () => '<active_agent name="worker"/>';
      if (race === "mode") h.ctx.sessionManager.getEntries().push({ type: "custom", customType: "agent-mode",
        id: "mode", parentId: null, timestamp: "now", data: { planReviewPending: true } });
      release();
      await settling;
      expect(h.sendMessage).not.toHaveBeenCalled();
    });

  it("invalidates enrollment on session start/tree and resumes listening after shutdown", async () => {
    const h = setup();
    await h.start();
    const task = h.runtime.store.create("A", "A");
    await h.enroll(task.id);
    await h.fire({ type: "session_shutdown", reason: "quit" });
    h.events.emit("user-prompted", {});
    await h.fire({ type: "session_start", reason: "resume" });
    await h.fire({ type: "agent_start" });
    await h.settle();
    expect(h.sendMessage).not.toHaveBeenCalled();
    await h.start();
    await h.enroll(task.id);
    h.events.emit("user-prompted", {});
    await h.settle();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});
