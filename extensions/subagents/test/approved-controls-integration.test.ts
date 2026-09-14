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
  const execute = (name = "Agent", input = params, id = "call", update?: (result: Result) => void) => tools.get(name)!.execute(id, input, undefined, update, ctx);
  return { execute, finish, lifecycle, appliers: appliers!, ctx };
}

it("reports final deltas once across retrieval and resume, never on partial results", async () => {
  const { execute, finish } = activate({ reportUsage: true, showCost: true });
  const updates: Result[] = [];
  const result = await execute("Agent", params, "spawn", (value) => updates.push(value));
  expect(updates.every((value) => value.usage === undefined)).toBe(true);
  expect(result.usage).toBeUndefined();
  expect(result.details?.cost).toBe(0.25);
  expect((await finish("Agent", result)).usage).toMatchObject({ input: 10, output: 2, cacheRead: 7, cost: { total: 0.25 } });
  const read = await execute("get_subagent_result", { agent_id: result.details!.agentId } as unknown as typeof params);
  expect((await finish("get_subagent_result", read)).usage).toBeUndefined();
  const resumed = await execute("Agent", { ...params, resume: result.details!.agentId } as typeof params);
  expect((await finish("Agent", resumed)).usage?.cost.total).toBe(0.25);
});

it("holds background usage for an eligible result and merges foreign usage", async () => {
  const { execute, finish } = activate({ reportUsage: true });
  const result = await execute("Agent", { ...params, run_in_background: true } as typeof params);
  await Promise.resolve();
  expect((await finish("Agent", result, "")).usage).toBeUndefined();
  expect((await finish("read", result)).usage).toBeUndefined();
  const foreign: Usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
  const merged = await finish("steer_subagent", result, "steer", foreign);
  expect(merged.usage).toMatchObject({ input: 11, output: 4, cacheRead: 10, cacheWrite: 7, totalTokens: 32, cost: { input: 1, total: 10.25 } });
  expect(foreign.input).toBe(1);
  expect((await finish("get_subagent_result", result)).usage).toBeUndefined();
});

it("defaults reporting and cost off, but tracks costs", async () => {
  const { execute, finish } = activate();
  const result = await execute();
  expect(result.details?.cost).toBeUndefined();
  expect((await finish("Agent", result)).usage).toBeUndefined();
});

it.each(["session_start", "session_shutdown"])("clears unreported usage on %s", async (event) => {
  const { execute, finish, lifecycle } = activate({ reportUsage: true });
  const result = await execute();
  await lifecycle(event);
  expect((await finish("get_subagent_result", result)).usage).toBeUndefined();
});

it.each([undefined, "chosen"])("does not invent model mismatch for inherited/fuzzy %s", async (requested) => {
  const { execute } = activate();
  const result = await execute("Agent", { ...params, model: requested } as typeof params);
  expect(result.details?.modelName).toBe("test/chosen");
  expect(result.details?.requestedModel).toBeUndefined();
  expect(result.details?.requestedThinking).toBeUndefined();
});

it("discloses original overridden request and thinking clamp across resume", async () => {
  writeFileSync(join(dir, ".pi", "agents", "fixture.md"), "---\nname: fixture\ndescription: fixture\nmodel: test/chosen\nthinking: high\n---\nTask");
  const { execute } = activate();
  const result = await execute("Agent", { ...params, model: "missing", thinking: "MAX" } as typeof params);
  expect(result.details).toMatchObject({ modelName: "test/chosen", thinking: "low", requestedModel: "missing", requestedThinking: "max" });
  const resumed = await execute("Agent", { ...params, resume: result.details!.agentId, model: "chosen", thinking: "low" } as typeof params);
  expect(resumed.details).toMatchObject({ requestedModel: "missing", requestedThinking: "max" });
});


it("drops pending usage when disabled and does not accumulate while off", async () => {
  const { execute, finish, appliers } = activate({ reportUsage: true });
  await execute();
  appliers.setReportUsage!(false);
  const off = await execute();
  appliers.setReportUsage!(true);
  expect((await finish("Agent", off)).usage).toBeUndefined();
  const fresh = await execute();
  expect((await finish("Agent", fresh)).usage?.input).toBe(10);
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
  const first = await execute("Agent", { ...params, run_in_background: true } as typeof params);
  const queued = await execute("Agent", { ...params, model: "chosen", thinking: "high", run_in_background: true } as typeof params);
  expect(queued.details?.status).toBe("queued");
  for (const field of ["modelName", "thinking", "requestedModel", "requestedThinking"] as const) expect(queued.details?.[field]).toBeUndefined();
  const running = await execute("get_subagent_result", { agent_id: first.details!.agentId } as unknown as typeof params);
  expect(running.details?.status).toBe("running");
  expect((await finish("get_subagent_result", running)).usage?.input).toBe(10);
  release!();
  await execute("get_subagent_result", { agent_id: queued.details!.agentId, wait: true } as unknown as typeof params);
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
  expect((await finish("Agent", result)).usage?.input).toBe(10);
});

it("preserves pending usage through a switch preflight that does not commit", async () => {
  const { execute, finish, lifecycle } = activate({ reportUsage: true });
  const result = await execute();
  await lifecycle("session_before_switch");
  // Another extension can cancel the switch: no shutdown/start follows.
  expect((await finish("get_subagent_result", result)).usage?.input).toBe(10);
  expect((await finish("get_subagent_result", result)).usage).toBeUndefined();
});

it.each([new Error("registry unavailable"), "registry unavailable"])("retains raw diagnostic intent when the registry throws %s", async (error) => {
  writeFileSync(join(dir, ".pi", "agents", "fixture.md"), "---\nname: fixture\ndescription: fixture\nmodel: test/chosen\n---\nTask");
  const { execute, ctx } = activate();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(ctx.modelRegistry, "getAvailable")
    .mockReturnValueOnce([session.model!])
    .mockImplementationOnce(() => { throw error; });
  const result = await execute("Agent", { ...params, model: "original" } as typeof params);
  expect(result.details).toMatchObject({ status: "completed", modelName: "test/chosen", requestedModel: "original" });
  expect(warn).toHaveBeenCalledOnce();
});
