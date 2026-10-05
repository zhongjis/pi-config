import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import extension from "../src/index.js";
import * as settingsModule from "../src/settings.js";
import type { AgentDetails } from "../src/ui/agent-widget.js";

interface Result { content: unknown[]; details?: AgentDetails; usage?: Usage }
interface Tool { name: string; execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: ((result: Result) => void) | undefined, ctx: ExtensionContext): Promise<Result> }
type ToolResultPatch = Partial<Pick<ToolResultEvent, "content" | "details" | "isError" | "usage">>;
type Hook = (event: ToolResultEvent, ctx: ExtensionContext) => Promise<ToolResultPatch | undefined> | ToolResultPatch | undefined;
let dir: string;
let cwd: string;
let cleanup: (() => Promise<void>) | undefined;
const model = { provider: "test", id: "chosen", name: "Chosen", reasoning: true };
const session = { model, thinkingLevel: "low", dispose: vi.fn(), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }) } as unknown as AgentSession;
const delta = { input: 10, output: 2, cacheWrite: 3, cacheRead: 7, cost: 0.25 };
const params = { prompt: "task", description: "test", subagent_type: "fixture" };
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "subagent-integration-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "global"));
  vi.stubEnv("HOME", dir);
  process.chdir(dir);
  mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
  writeFileSync(join(dir, ".pi", "agents", "fixture.md"), "---\nname: fixture\ndescription: fixture\n---\nTask");
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(session);
    options.onAssistantUsage?.(delta);
    return { responseText: "done", session, aborted: false, steered: false };
  });
  vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options) => {
    options?.onAssistantUsage?.(delta);
    return { text: "continued" };
  });
});
afterEach(async () => {
  await cleanup?.(); cleanup = undefined;
  process.chdir(cwd); vi.unstubAllEnvs(); vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function activate(settings: Record<string, unknown> = {}) {
  writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ outputTranscript: false, ...settings }));
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, Hook[]>();
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(),
    on: (event: string, hook: Hook) => hooks.set(event, [...(hooks.get(event) ?? []), hook]),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: false, ui: { setWidget: vi.fn(), setStatus: vi.fn(), notify: vi.fn() }, model,
    modelRegistry: { getAvailable: () => [model], find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined },
    sessionManager: { getSessionId: () => "parent", getEntries: () => [], getBranch: () => [] }, getSystemPrompt: () => "parent",
  } as unknown as ExtensionContext;
  let appliers: settingsModule.SettingsAppliers | undefined;
  const apply = settingsModule.applyAndEmitLoaded;
  vi.spyOn(settingsModule, "applyAndEmitLoaded").mockImplementation((setters, ...args) => {
    appliers = setters;
    return apply(setters, ...args);
  });
  extension(pi);
  const lifecycle = async (name: string) => { for (const hook of hooks.get(name) ?? []) await hook({} as ToolResultEvent, ctx); };
  cleanup = () => lifecycle("session_shutdown");
  const finish = async (name: string, result: Result, id = "call", usage?: Usage) => {
    let event = { type: "tool_result", toolName: name, toolCallId: id, input: {}, isError: false, ...result, usage } as ToolResultEvent;
    for (const hook of hooks.get("tool_result") ?? []) event = { ...event, ...await hook(event, ctx) };
    return event;
  };
  const execute = (name = "agent", input: Record<string, unknown> = params, id = "call", update?: (result: Result) => void) => tools.get(name)!.execute(id, input, undefined, update, ctx);
  return { execute, finish, lifecycle, appliers: appliers!, ctx, pi };
}

it.each([
  { grouped: false, partial: undefined },
  { grouped: true, partial: undefined },
  { grouped: false, partial: "already retained partial checkpoint" },
  { grouped: true, partial: "already retained partial checkpoint" },
])("non-waiting retrieval preserves smart stopped notification through physical drain ($grouped, $partial)", async ({ grouped, partial }) => {
  const records = vi.spyOn(AgentManager.prototype, "getRecord");
  const { execute, lifecycle, pi } = activate({ defaultJoinMode: "smart", schedulingEnabled: false });
  await lifecycle("session_start");
  const stop = vi.mocked(pi.events.on).mock.calls.find(([name]) => name === "subagents:rpc:stop")?.[1];
  if (!stop) throw new Error("Stop RPC was not registered");
  vi.useFakeTimers();
  let release: (() => void) | undefined;
  const drain = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(runAgent).mockImplementationOnce(async () => { await drain; return { responseText: "retained stopped checkpoint", session, aborted: false, steered: false }; });
  try {
    const started = await execute("agent", { ...params, run_in_background: true });
    if (grouped) await execute("agent", { ...params, run_in_background: true });
    await stop({ requestId: "stop", agentId: started.details?.agentId });
    const record = records.mock.results.map(result => result.value).find(value => value?.id === started.details?.agentId);
    if (!record) throw new Error("Missing started record");
    record.result = partial;
    let snapshot: Result | undefined;
    const retrieval = execute("get_agent_result", { run_id: started.details?.agentId, wait: false }).then(result => { snapshot = result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot?.details).toMatchObject({ status: "stopped", interruptionCause: "caller", result: partial ?? "" });
    const text = JSON.stringify(snapshot?.content);
    expect(text).toContain("Agent execution is still pending.");
    expect(text).toContain("get_agent_result");
    expect(text).toContain("wait: true");
    expect(text).toContain("do not resume");
    expect(text).toContain("do not end your turn");
    expect(text).not.toContain("No output.");
    if (partial) expect(text).toContain(partial);
    expect(record.resultConsumed).toBe(false);
    await retrieval;
    await vi.advanceTimersByTimeAsync(300);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    release?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pi.sendMessage).mock.calls[0]?.[0].content).toContain("retained stopped checkpoint");
    const retrieved = await execute("get_agent_result", { run_id: started.details?.agentId, wait: true });
    expect(retrieved.details).toMatchObject({ status: "stopped", result: "retained stopped checkpoint" });
    expect(JSON.stringify(retrieved.content)).not.toContain("Agent execution is still pending.");
    expect(record.resultConsumed).toBe(true);
  } finally { release?.(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); }
});

it("async queued cancellation notifies once without starting its SDK runner", async () => {
  const { execute, lifecycle, pi } = activate({ defaultJoinMode: "async", maxConcurrent: 1, schedulingEnabled: false });
  await lifecycle("session_start");
  const stop = vi.mocked(pi.events.on).mock.calls.find(([name]) => name === "subagents:rpc:stop")?.[1];
  if (!stop) throw new Error("Stop RPC was not registered");
  vi.useFakeTimers();
  let release: (() => void) | undefined;
  const drain = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(runAgent).mockClear().mockImplementationOnce(async () => { await drain; return { responseText: "busy", session, aborted: false, steered: false }; });
  try {
    await execute("agent", { ...params, run_in_background: true });
    const queued = await execute("agent", { ...params, run_in_background: true });
    expect(queued.details?.status).toBe("queued");
    const pending = await execute("get_agent_result", { run_id: queued.details?.agentId, wait: false });
    expect(pending.details?.status).toBe("queued");
    expect(JSON.stringify(pending.content)).toContain("Agent execution is still pending.");
    expect(JSON.stringify(pending.content)).toContain("wait: true");
    expect(JSON.stringify(pending.content)).not.toContain("No output.");
    await stop({ requestId: "stop-queued", agentId: queued.details?.agentId });
    await vi.advanceTimersByTimeAsync(300);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pi.sendMessage).mock.calls[0]?.[0].content).toContain(`<task-id>${queued.details?.agentId}</task-id>`);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const retrieved = await execute("get_agent_result", { run_id: queued.details?.agentId, wait: true });
    expect(retrieved.details).toMatchObject({ status: "stopped", interruptionCause: "caller" });
  } finally { release?.(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); }
});

it("returns background resume immediately with the same ID and delivers once", async () => {
  const { execute, pi } = activate({ defaultJoinMode: "async" });
  const original = await execute();
  const id = original.details?.agentId;
  if (!id) throw new Error("Missing agent ID");
  let release: (() => void) | undefined;
  const drain = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(resumeAgent).mockImplementationOnce(async () => { await drain; return { text: "background continued" }; });
  const pending = execute("agent", { ...params, resume: id, run_in_background: true });
  try {
    const early = await Promise.race([pending, new Promise<undefined>(resolve => setImmediate(() => resolve(undefined)))]);
    expect(early?.details).toMatchObject({ agentId: id, status: "background" });
  } finally { release?.(); await pending; }
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(vi.mocked(pi.sendMessage).mock.calls[0]?.[0].content).toContain("background continued");
  const retrieved = await execute("get_agent_result", { run_id: id, wait: true });
  expect(retrieved.details?.result).toBe("background continued");
  const foreground = await execute("agent", { ...params, resume: id });
  expect(foreground.details?.result).toBe("continued");
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(pi.sendMessage).toHaveBeenCalledTimes(1);
});

it.each(["user", "unknown", "supervisor-idle"] as const)("foreground resume reports %s interruption rather than completion", async (cause) => {
  const { execute } = activate();
  const original = await execute();
  const id = original.details?.agentId;
  if (!id) throw new Error("Missing agent ID");
  vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "retained checkpoint", interruptionCause: cause });
  const resumed = await execute("agent", { ...params, resume: id });
  expect(resumed.details).toMatchObject({ status: "aborted", interruptionCause: cause, result: "retained checkpoint" });
  const content = JSON.stringify(resumed.content);
  expect(content).toContain("task is unfinished");
  expect(content.includes("STOPPED BY THE USER")).toBe(cause === "user");
});

it("reports final deltas once across retrieval and resume, never on partial results", async () => {
  const { execute, finish } = activate({ reportUsage: true, showCost: true });
  const updates: Result[] = [];
  const result = await execute("agent", params, "spawn", (value) => updates.push(value));
  expect(updates.every((value) => value.usage === undefined)).toBe(true);
  expect(result.usage).toBeUndefined();
  expect(result.details?.cost).toBe(0.25);
  expect((await finish("agent", result)).usage).toMatchObject({ input: 10, output: 2, cacheRead: 7, cost: { total: 0.25 } });
  const read = await execute("get_agent_result", { run_id: result.details!.agentId } as unknown as typeof params);
  expect((await finish("get_agent_result", read)).usage).toBeUndefined();
  const resumed = await execute("agent", { ...params, resume: result.details!.agentId } as typeof params);
  expect((await finish("agent", resumed)).usage?.cost.total).toBe(0.25);
});

it("holds background usage for an eligible result and merges foreign usage", async () => {
  const { execute, finish } = activate({ reportUsage: true });
  const result = await execute("agent", { ...params, run_in_background: true } as typeof params);
  await Promise.resolve();
  expect((await finish("agent", result, "")).usage).toBeUndefined();
  expect((await finish("read", result)).usage).toBeUndefined();
  const foreign: Usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
  const merged = await finish("steer_subagent", result, "steer", foreign);
  expect(merged.usage).toMatchObject({ input: 11, output: 4, cacheRead: 10, cacheWrite: 7, totalTokens: 32, cost: { input: 1, total: 10.25 } });
  expect(foreign.input).toBe(1);
  expect((await finish("get_agent_result", result)).usage).toBeUndefined();
});

it("defaults reporting and cost off, but tracks costs", async () => {
  const { execute, finish } = activate();
  const result = await execute();
  expect(result.details?.cost).toBeUndefined();
  expect((await finish("agent", result)).usage).toBeUndefined();
});

it.each(["session_start", "session_shutdown"])("clears unreported usage on %s", async (event) => {
  const { execute, finish, lifecycle } = activate({ reportUsage: true });
  const result = await execute();
  await lifecycle(event);
  expect((await finish("get_agent_result", result)).usage).toBeUndefined();
});

it("does not invent a model mismatch for an inherited model", async () => {
  const { execute } = activate();
  const result = await execute();
  expect(result.details?.modelName).toBe("test/chosen");
  expect(result.details?.requestedModel).toBeUndefined();
  expect(result.details?.requestedThinking).toBeUndefined();
});

it("ignores caller model and thinking overrides, disclosing only the frontmatter clamp", async () => {
  writeFileSync(join(dir, ".pi", "agents", "fixture.md"), "---\nname: fixture\ndescription: fixture\nmodel: test/chosen\nthinking: high\n---\nTask");
  const { execute } = activate();
  const result = await execute("agent", { ...params, model: "missing", thinking: "MAX" } as typeof params);
  expect(result.details).toMatchObject({ modelName: "test/chosen", thinking: "low", requestedThinking: "high" });
  expect(result.details?.requestedModel).toBeUndefined();
  const resumed = await execute("agent", { ...params, resume: result.details!.agentId, model: "chosen", thinking: "low" } as typeof params);
  expect(resumed.details).toMatchObject({ requestedThinking: "high" });
  expect(resumed.details?.requestedModel).toBeUndefined();
});


it("drops pending usage when disabled and does not accumulate while off", async () => {
  const { execute, finish, appliers } = activate({ reportUsage: true });
  await execute();
  appliers.setReportUsage!(false);
  const off = await execute();
  appliers.setReportUsage!(true);
  expect((await finish("agent", off)).usage).toBeUndefined();
  const fresh = await execute();
  expect((await finish("agent", fresh)).usage?.input).toBe(10);
});

it("shows configuration thinking clamping even without a caller thinking override", async () => {
  writeFileSync(join(dir, ".pi", "agents", "fixture.md"), "---\nname: fixture\ndescription: fixture\nmodel: test/chosen:high\n---\nTask");
  const { execute } = activate();
  expect((await execute()).details).toMatchObject({ thinking: "low", requestedThinking: "high" });
});

it("keeps queued details free of actual and mismatch claims, then reports running spend", async () => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(session);
    options.onAssistantUsage?.(delta);
    await wait;
    return { responseText: "done", session, aborted: false, steered: false };
  });
  const { execute, finish } = activate({ maxConcurrent: 1, reportUsage: true });
  const first = await execute("agent", { ...params, run_in_background: true } as typeof params);
  const queued = await execute("agent", { ...params, run_in_background: true } as typeof params);
  expect(queued.details?.status).toBe("queued");
  for (const field of ["modelName", "thinking", "requestedModel", "requestedThinking"] as const) expect(queued.details?.[field]).toBeUndefined();
  const running = await execute("get_agent_result", { run_id: first.details!.agentId } as unknown as typeof params);
  expect(running.details?.status).toBe("running");
  expect((await finish("get_agent_result", running)).usage?.input).toBe(10);
  release!();
  await execute("get_agent_result", { run_id: queued.details!.agentId, wait: true } as unknown as typeof params);
});

it("retains spent deltas through failed calls", async () => {
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(session);
    options.onAssistantUsage?.(delta);
    throw new Error("cancelled after billing");
  });
  const { execute, finish } = activate({ reportUsage: true });
  const result = await execute();
  expect(result.details?.status).toBe("error");
  expect((await finish("agent", result)).usage?.input).toBe(10);
});

it("preserves pending usage through a switch preflight that does not commit", async () => {
  const { execute, finish, lifecycle } = activate({ reportUsage: true });
  const result = await execute();
  await lifecycle("session_before_switch");
  // Another extension can cancel the switch: no shutdown/start follows.
  expect((await finish("get_agent_result", result)).usage?.input).toBe(10);
  expect((await finish("get_agent_result", result)).usage).toBeUndefined();
});

it("prepares configured direct model, thinking, and normalized max turns before spawning", async () => {
  writeFileSync(
    join(dir, ".pi", "agents", "fixture.md"),
    "---\nname: fixture\ndescription: fixture\nmodel: test/chosen:high\nmax_turns: 0\n---\nTask",
  );
  const { execute } = activate();
  vi.mocked(runAgent).mockClear();
  await execute("agent", { ...params, model: "test/missing", thinking: "low", max_turns: 3 } as typeof params);
  expect(vi.mocked(runAgent).mock.calls.at(-1)?.[3]).toMatchObject({
    selectedModel: { model, modelInput: "test/chosen:high" },
    thinkingLevel: "high",
    maxTurns: undefined,
  });
});

it("warns but runs when the configured direct model is out of scope", async () => {
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/allowed"] }));
  writeFileSync(
    join(dir, ".pi", "agents", "fixture.md"),
    "---\nname: fixture\ndescription: fixture\nmodel: test/chosen\n---\nTask",
  );
  const { execute, ctx } = activate({ scopeModels: true });
  const allowed = { ...model, id: "allowed" };
  (ctx.modelRegistry as { getAvailable: () => typeof model[] }).getAvailable = () => [model, allowed];
  vi.mocked(runAgent).mockClear();
  await execute();
  expect(ctx.ui.notify).toHaveBeenCalledWith('Agent "fixture" using out-of-scope model "test/chosen"', "warning");
  expect(runAgent).toHaveBeenCalledOnce();
});
