/**
 * Tests for system-reminder *delivery* (ported from upstream 0.7.0).
 *
 * The periodic reminder must no longer be appended onto unrelated tool
 * results (which persisted a now-stale <system-reminder> into session
 * history). Instead, `tool_result` only tracks cadence via the local
 * ContinuationCooldown, and the reminder is injected as a transient one-shot
 * user message via the `context` hook. These tests lock that behavior in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMINDER_INTERVAL } from "../src/constants.js";
import {
  createTaskRuntime,
  registerLifecycleEvents,
  SYSTEM_REMINDER,
  type TaskRuntime,
} from "../src/lifecycle/store-glue.js";

// Force in-memory store so reminders evaluate against an isolated task list.
beforeEach(() => {
  process.env.PI_TASKS = "off";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.PI_TASKS;
  vi.restoreAllMocks();
});

/** Minimal mock pi that captures lifecycle handlers and can fire them. */
function mockPi() {
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const pi = {
    on(event: string, handler: any) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
  } as any;
  async function fire(event: string, ...args: any[]) {
    let last: any = {};
    for (const h of handlers.get(event) ?? []) last = await h(...args);
    return last;
  }
  return { pi, fire };
}

function mockCtx() {
  return {
    sessionManager: { getSessionId: () => "session-1", getEntries: () => [] },
    ui: { setWidget: vi.fn(), setStatus: vi.fn(), notify: vi.fn() },
  };
}

/** Advance `n` turns so the cooldown's idle counter elapses. */
async function advanceTurns(fire: (e: string, ...a: any[]) => Promise<any>, ctx: any, n: number) {
  for (let i = 0; i < n; i++) await fire("turn_start", {}, ctx);
}

function setup() {
  const { pi, fire } = mockPi();
  const runtime: TaskRuntime = createTaskRuntime();
  registerLifecycleEvents(pi, runtime);
  return { fire, runtime, ctx: mockCtx() };
}

describe("system-reminder delivery", () => {
  it("does NOT mutate tool_result content when the reminder fires; it only queues it", async () => {
    const { fire, runtime, ctx } = setup();
    runtime.store.create("Task A", "desc"); // store.list().length > 0

    await advanceTurns(fire, ctx, REMINDER_INTERVAL + 1);

    const original = [{ type: "text" as const, text: "file contents" }];
    const result = await fire("tool_result", { toolName: "read", content: original });

    // tool output is untouched — no <system-reminder> appended.
    expect(result).toEqual({});
    // ...but the reminder is now queued for the next LLM call.
    expect(runtime.reminderDue).toBe(true);
  });

  it("injects the reminder transiently via context, then clears it (one-shot)", async () => {
    const { fire, runtime, ctx } = setup();
    runtime.store.create("Task A", "desc");

    await advanceTurns(fire, ctx, REMINDER_INTERVAL + 1);
    await fire("tool_result", { toolName: "read", content: [] });
    expect(runtime.reminderDue).toBe(true);

    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }];
    const out = await fire("context", { type: "context", messages });

    const injected = out.messages?.[out.messages.length - 1];
    expect(injected.role).toBe("user");
    expect(injected.content[0].text).toBe(SYSTEM_REMINDER);
    // original messages array is not mutated (transient transform only).
    expect(messages).toHaveLength(1);
    // flag drained — second context does not re-inject.
    expect(runtime.reminderDue).toBe(false);

    const out2 = await fire("context", { type: "context", messages });
    expect(out2).toEqual({});
  });

  it("does not queue a reminder before the interval elapses", async () => {
    const { fire, runtime, ctx } = setup();
    runtime.store.create("Task A", "desc");

    await advanceTurns(fire, ctx, 2); // < REMINDER_INTERVAL
    const result = await fire("tool_result", { toolName: "read", content: [] });

    expect(result).toEqual({});
    expect(runtime.reminderDue).toBe(false);
    expect(await fire("context", { type: "context", messages: [] })).toEqual({});
  });

  it("a task tool resets cadence and never queues a reminder", async () => {
    const { fire, runtime, ctx } = setup();
    runtime.store.create("Task A", "desc");

    await advanceTurns(fire, ctx, REMINDER_INTERVAL + 1);
    const result = await fire("tool_result", { toolName: "Task", content: [] });

    expect(result).toEqual({});
    expect(runtime.reminderDue).toBe(false);
  });

  it("session_switch clears a pending reminder", async () => {
    const { fire, runtime, ctx } = setup();
    runtime.store.create("Task A", "desc");

    await advanceTurns(fire, ctx, REMINDER_INTERVAL + 1);
    await fire("tool_result", { toolName: "read", content: [] });
    expect(runtime.reminderDue).toBe(true);

    await fire("session_switch", { reason: "new" }, ctx);
    expect(runtime.reminderDue).toBe(false);
  });
});
