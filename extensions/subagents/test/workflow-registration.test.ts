import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});
const settingsUI = vi.hoisted(() => ({ change: undefined as ((id: string, value: string) => void) | undefined }));
vi.mock("@earendil-works/pi-tui", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-tui")>("@earendil-works/pi-tui");
  return { ...actual, SettingsList: class {
    constructor(_items: unknown, _height: number, _theme: unknown, change: (id: string, value: string) => void) {
      settingsUI.change = change;
    }
  } };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import extension, { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "../src/index.js";
import { loadSettings } from "../src/settings.js";
import { decideWorkflowCollision } from "../src/workflow/collisions.js";
import * as workflowHost from "../src/workflow/host.js";
import { listSavedWorkflows, resolveWorkflowScript } from "../src/workflow/saved.js";

type Result = { content: { type: string; text?: string }[]; details?: { taskId?: string }; usage?: ToolResultEvent["usage"] };
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
type Tool = { name: string; description: string; parameters: { properties: Record<string, unknown> }; renderResult(result: Result, options: { expanded: boolean }, theme: typeof plainTheme, context: { isError: boolean }): { render(width: number): string[] }; execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext): Promise<Result> };
type Hook = (event: unknown, ctx: ExtensionContext) => unknown;
const source = "export const meta = {name:'fixture', description:'registration test'}; return await agent(args.prompt, {agentType:'fixture'});";
const model = { provider: "test", id: "chosen", name: "Chosen", reasoning: true };
let dir: string;
let originalCwd: string;
let session: AgentSession;
let shutdown: (() => Promise<void>) | undefined;
const artifactDirs = new Set<string>();

function required<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "workflow-registration-"));
  process.chdir(dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "global"));
  vi.stubEnv("HOME", dir);
  mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
  writeFileSync(join(dir, ".pi", "agents", "fixture.md"), "---\nname: fixture\ndescription: test\n---\nTask");
  const sessionFixture: Partial<AgentSession> = {
    model: model as AgentSession["model"], thinkingLevel: "low", dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }) as ReturnType<AgentSession["getSessionStats"]>,
  };
  session = sessionFixture as AgentSession;
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, options) => {
    options.onSessionCreated?.(session);
    options.onAssistantUsage?.({ input: 10, output: 2, cacheWrite: 3, cacheRead: 7, cost: 0.25 });
    return { responseText: prompt, session, aborted: false, steered: false };
  });
});
afterEach(async () => {
  await shutdown?.(); shutdown = undefined;
  process.chdir(originalCwd);
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
  for (const path of artifactDirs) rmSync(path, { recursive: true, force: true });
  artifactDirs.clear();
});

function boot(settings: Record<string, unknown> = {}) {
  writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ outputTranscript: false, ...settings }));
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, Hook[]>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  let flag: unknown;
  let foreign: { name: string; description: string }[] = [];
  const ui = { setWidget: vi.fn(), setStatus: vi.fn(), notify: vi.fn(), select: vi.fn(), custom: vi.fn() };
  const api = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
    registerMessageRenderer: vi.fn(), registerEntryRenderer: vi.fn(), registerFlag: vi.fn(),
    getFlag: vi.fn(() => flag), getAllTools: () => [...foreign, ...tools.values()],
    getActiveTools: () => [...tools.keys()], setActiveTools: vi.fn(),
    on: (name: string, hook: Hook) => hooks.set(name, [...(hooks.get(name) ?? []), hook]),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage: vi.fn(),
  };
  const uiFixture: Partial<ExtensionContext["ui"]> = ui;
  const modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable" | "find"> = {
    getAvailable: () => [model as NonNullable<ExtensionContext["model"]>], find: () => model as NonNullable<ExtensionContext["model"]>,
  };
  const sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries" | "getBranch"> = {
    getSessionId: () => "parent", getEntries: () => [], getBranch: () => [],
  };
  const ctxFixture: Partial<ExtensionContext> = { cwd: dir, hasUI: false, ui: uiFixture as ExtensionContext["ui"], model: model as ExtensionContext["model"],
    modelRegistry: modelRegistry as ExtensionContext["modelRegistry"],
    sessionManager: sessionManager as ExtensionContext["sessionManager"],
    getSystemPrompt: () => "parent",
  };
  const ctx = ctxFixture as ExtensionContext;
  const extensionApi: Pick<ExtensionAPI, "events" | "appendEntry" | "sendMessage" | "registerFlag" | "registerMessageRenderer" | "setActiveTools" | "getActiveTools"> = api;
  extension(extensionApi as ExtensionAPI);
  const lifecycle = async (name: string) => { for (const hook of hooks.get(name) ?? []) await hook({}, ctx); };
  shutdown = () => lifecycle("session_shutdown");
  const execute = async (input: Record<string, unknown>) => {
    const result = await required(tools.get("SubagentWorkflow")).execute("call", input, undefined, undefined, ctx);
    const path = result.content[0]?.text?.match(/Script: (.+)/)?.[1];
    if (path?.includes("/pi-subagents-")) artifactDirs.add(dirname(path));
    return result;
  };
  const finish = async (result: Result) => {
    let event = { type: "tool_result", toolName: "SubagentWorkflow", toolCallId: "call", input: {}, isError: false, ...result };
    for (const hook of hooks.get("tool_result") ?? []) event = { ...event, ...await hook(event, ctx) as object };
    return event as Result;
  };
  const notification = async (id: string) => {
    await vi.waitFor(() => expect(api.sendMessage.mock.calls.some(([message]) => message.content.includes(`<task-id>${id}</task-id>`))).toBe(true));
    return required(api.sendMessage.mock.calls.find(([message]) => message.content.includes(`<task-id>${id}</task-id>`)))[0];
  };
  return { api, ui, tools, ctx, commands, execute, finish, notification, lifecycle,
    setFlag: (value: unknown) => { flag = value; }, setForeign: (value: typeof foreign) => { foreign = value; } };
}

it("registers no workflow tool by default; the flag is read only at startup", async () => {
  const host = boot();
  expect(host.tools.has("SubagentWorkflow")).toBe(false);
  expect(host.api.getFlag).not.toHaveBeenCalled();
  expect(host.api.registerFlag).toHaveBeenCalledWith(WORKFLOW_FILE_FLAG, expect.objectContaining({ type: "string" }));
  host.setFlag("missing.js");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await host.lifecycle("session_start");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("workflows are off"));
  expect(runAgent).not.toHaveBeenCalled();
});

it.each([false, "true", 1, null])("keeps workflows disabled for non-opt-in settings %s", (workflowsEnabled) => {
  const host = boot({ workflowsEnabled });
  expect(host.tools.has("SubagentWorkflow")).toBe(false);
  expect(loadSettings(dir).workflowsEnabled).toBe(workflowsEnabled === false ? false : undefined);
});

it("persists the Settings toggle but registers its schema only on the next activation", async () => {
  const host = boot();
  host.ui.select.mockResolvedValueOnce("Settings").mockResolvedValueOnce(undefined);
  host.ui.custom.mockImplementation(async (factory) => {
    factory({}, {}, {}, () => {});
    required(settingsUI.change)("workflowsEnabled", "on");
    return undefined;
  });
  await required(host.commands.get("agents")).handler("", host.ctx);
  expect(loadSettings(dir).workflowsEnabled).toBe(true);
  expect(host.tools.has("SubagentWorkflow")).toBe(false);
  await host.lifecycle("session_shutdown");
  const reloaded = boot({ ...loadSettings(dir) });
  expect(reloaded.tools.get("SubagentWorkflow")?.parameters.properties).toHaveProperty("resumeFromRunId");
});

it("runs owned children, emits one owner notification, and drains native usage once on a final workflow result", async () => {
  const host = boot({ workflowsEnabled: true, reportUsage: true });
  const result = await host.execute({ script: source, args: { prompt: "original\nexpanded tail" } });
  const message = await host.notification(required(result.details?.taskId));
  expect(message.content).toContain("<result>original\nexpanded tail</result>");
  const tool = required(host.tools.get("SubagentWorkflow"));
  const compact = tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(80);
  expect(compact.length).toBeLessThanOrEqual(3);
  expect(compact.join("\n")).toContain("original");
  expect(compact.join("\n")).not.toContain("expanded tail");
  expect(tool.renderResult(result, { expanded: true }, plainTheme, { isError: false }).render(80).join("\n")).toContain("expanded tail");
  expect(host.api.sendMessage).toHaveBeenCalledTimes(1);
  expect(host.api.events.emit.mock.calls.some(([name]) => name === "subagents:completed")).toBe(false);
  expect(vi.mocked(runAgent).mock.calls[0][3].workflow).toBe(true);
  expect((await host.finish(result)).usage).toMatchObject({ input: 10, cacheRead: 7, cost: { total: 0.25 } });
  expect((await host.finish(result)).usage).toBeUndefined();
});

it("reuses omitted source and original args, and actually replays only an unchanged prefix", async () => {
  const host = boot({ workflowsEnabled: true });
  const first = await host.execute({ script: source, args: { prompt: "original" } });
  const firstId = required(first.details?.taskId);
  await host.notification(firstId);
  const resumed = await host.execute({ resumeFromRunId: firstId });
  expect((await host.notification(required(resumed.details?.taskId))).content).toContain("1 replayed");
  expect(runAgent).toHaveBeenCalledTimes(1);
  const changed = await host.execute({ resumeFromRunId: firstId, args: { prompt: "changed" } });
  expect((await host.notification(required(changed.details?.taskId))).content).toContain("<result>changed</result>");
  expect(runAgent).toHaveBeenCalledTimes(2);
  expect((await host.execute({ resumeFromRunId: "wf_unknown" })).content[0].text).toContain("No workflow run");
});

it("does not claim replay when a journal has no recorded prefix", async () => {
  const host = boot({ workflowsEnabled: true });
  const first = await host.execute({ script: "export const meta={name:'empty',description:'empty'}; return args", args: "original" });
  const firstId = required(first.details?.taskId);
  await host.notification(firstId);
  const resumed = await host.execute({ resumeFromRunId: firstId });
  expect(resumed.content[0].text).toContain("Nothing to replay");
  expect((await host.notification(required(resumed.details?.taskId))).content).toContain("<result>original</result>");
});

it.each(["session_shutdown", "session_start"])("%s waits for owned teardown and suppresses stale completion", async (event) => {
  const host = boot({ workflowsEnabled: true });
  let finishChild: (() => void) | undefined;
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    await new Promise<void>(resolve => { finishChild = resolve; });
    return { responseText: "stopped", session, aborted: options.signal?.aborted ?? false, steered: false };
  });
  const result = await host.execute({ script: source, args: { prompt: "wait" } });
  await vi.waitFor(() => expect(finishChild).toBeDefined());
  let settled = false;
  const stopping = host.lifecycle(event).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  required(finishChild)();
  await stopping;
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(host.api.sendMessage).not.toHaveBeenCalled();
  expect((await host.execute({ resumeFromRunId: required(result.details?.taskId) })).content[0].text).toContain(event === "session_shutdown" ? "unavailable" : "No workflow run");
});

it("runs the CLI file once and writes one entry without triggering a turn", async () => {
  const host = boot({ workflowsEnabled: true });
  writeFileSync(join(dir, "workflow.js"), "export const meta={name:'cli',description:'test'}; return ['ok', 'entry tail'].join('\\n')");
  host.setFlag("workflow.js");
  await host.lifecycle("session_start");
  await vi.waitFor(() => expect(host.api.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.objectContaining({ status: "completed" })));
  expect(host.api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "workflow-result", display: false }), { deliverAs: "nextTurn" });
  const data = required(host.api.appendEntry.mock.calls.find(([name]) => name === WORKFLOW_ENTRY_TYPE))[1];
  expect(data.value).toBe("ok\nentry tail");
  const renderer = required(host.api.registerEntryRenderer.mock.calls.find(([name]) => name === WORKFLOW_ENTRY_TYPE))[1];
  expect(renderer({ data }, { expanded: true }, plainTheme).render(80).join("\n")).toContain("entry tail");
  expect(renderer({ data }, { expanded: false }, plainTheme).render(80).join("\n")).not.toContain("entry tail");
  await host.lifecycle("session_start");
  expect(host.api.appendEntry).toHaveBeenCalledTimes(1);
});

it("rejects a bare workflow-file flag and reports same-name tool collisions", async () => {
  const host = boot({ workflowsEnabled: true });
  host.setFlag(true);
  host.setForeign([{ name: "SubagentWorkflow", description: "foreign" }]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await host.lifecycle("session_start");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("needs a path"));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("first registration"));
  expect(host.api.setActiveTools).not.toHaveBeenCalled();
});

describe("saved discovery and collision policy", () => {
  it("resolves project/workspace/global names, keeps explicit source precedence, and rejects traversal", () => {
    const roots = [join(dir, ".pi", "workflows"), join(dir, ".agents", "workflows"), join(dir, "global", "workflows")];
    for (const [index, root] of roots.entries()) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "named.js"), `export const meta={name:'${index}',description:'test'};return ${index}`);
    }
    writeFileSync(join(roots[0], "helper.js"), "throw new Error('must not execute')");
    symlinkSync(join(roots[0], "named.js"), join(roots[0], "linked.js"));
    expect(resolveWorkflowScript({ name: "linked" }, dir).ok).toBe(false);
    expect(listSavedWorkflows(dir)).toEqual(["named"]);
    expect(resolveWorkflowScript({ name: "named" }, dir)).toMatchObject({ ok: true, scriptPath: join(roots[0], "named.js") });
    expect(resolveWorkflowScript({ name: "named", script: source }, dir)).toMatchObject({ script: source });
    expect(resolveWorkflowScript({ scriptPath: join(roots[2], "named.js"), script: source }, dir)).toMatchObject({ script: readFileSync(join(roots[2], "named.js"), "utf-8") });
    expect(resolveWorkflowScript({ name: "../named" }, dir).ok).toBe(false);
    expect(resolveWorkflowScript({ name: "helper" }, dir).ok).toBe(false);
  });
  it.each(["Workflow", "workflow"])("detects exact %s names and honors explicit opt-in", (name) => {
    const input = { tools: [{ name, description: "foreign" }], ownDescription: "ours", pinned: false };
    expect(decideWorkflowCollision(input)).toMatchObject({ kind: "standDown", withdraw: true });
    expect(decideWorkflowCollision({ ...input, pinned: true }).kind).toBe("none");
    expect(decideWorkflowCollision({ ...input, tools: [{ name: `get_${name}`, description: "foreign" }] }).kind).toBe("none");
  });
});


it("hides owned children in the ordinary menu count and running-agent list", async () => {
  const host = boot({ workflowsEnabled: true });
  const workflow = await host.execute({ script: source, args: { prompt: "owned child" } });
  const id = workflow.details?.taskId;
  assert.ok(id);
  await host.notification(id);
  const agent = host.tools.get("Agent");
  assert.ok(agent);
  await agent.execute("ordinary", { subagent_type: "fixture", prompt: "ordinary", description: "ordinary" }, undefined, undefined, host.ctx);
  host.ui.select.mockImplementationOnce(async (_title, choices: string[]) => {
    const running = choices.find(choice => choice.startsWith("Running agents ("));
    expect(running).toContain("Running agents (1)");
    return running;
  }).mockImplementationOnce(async (title, choices: string[]) => {
    expect(title).toBe("Running agents");
    expect(choices).toHaveLength(1);
    expect(choices[0]).toContain("ordinary");
    expect(choices[0]).not.toContain("owned child");
    return undefined;
  });
  await host.commands.get("agents")?.handler("", host.ctx);
  expect(host.ui.select).toHaveBeenCalledTimes(3);
});

it("keeps registration, execution and menus enabled until reload after disabling the setting", async () => {
  const host = boot({ workflowsEnabled: true });
  host.ui.select.mockResolvedValueOnce("Settings");
  host.ui.custom.mockImplementation(async factory => {
    factory({}, {}, {}, () => {});
    settingsUI.change?.("workflowsEnabled", "off");
  });
  await host.commands.get("agents")?.handler("", host.ctx);
  expect(loadSettings(dir).workflowsEnabled).toBe(false);
  expect(host.ui.select.mock.calls.at(-1)?.[1]).toContain("Workflows (0)");
  const run = await host.execute({ script: "export const meta={name:'enabled',description:'enabled'}; return 'still enabled'" });
  const id = run.details?.taskId;
  assert.ok(id);
  expect((await host.notification(id)).content).toContain("still enabled");
  await host.lifecycle("session_shutdown");
  expect(boot({ ...loadSettings(dir) }).tools.has("SubagentWorkflow")).toBe(false);
});

it("initializes accounting before CLI workflow startup can deliver usage", async () => {
  let listener: Parameters<AgentManager["setUsageListener"]>[0];
  const setListener = AgentManager.prototype.setUsageListener;
  vi.spyOn(AgentManager.prototype, "setUsageListener").mockImplementation(function (this: AgentManager, next) {
    listener = next;
    setListener.call(this, next);
  });
  const createHost = workflowHost.createWorkflowHost;
  vi.spyOn(workflowHost, "createWorkflowHost").mockImplementation(options => {
    listener?.({ input: 9, output: 1, cacheWrite: 0 });
    return createHost(options);
  });
  const host = boot({ workflowsEnabled: true, reportUsage: true });
  writeFileSync(join(dir, "startup.js"), "export const meta={name:'startup',description:'startup'}; return 'ok'");
  host.setFlag("startup.js");
  await host.lifecycle("session_start");
  await vi.waitFor(() => expect(host.api.sendMessage).toHaveBeenCalled());
  expect((await host.finish({ content: [] })).usage?.input).toBe(9);
  expect((await host.finish({ content: [] })).usage).toBeUndefined();
});

it.each(["tool", "cli"])("%s completions expose the full oversized result through a readable artifact", async mode => {
  const host = boot({ workflowsEnabled: true });
  const full = "preview\n" + "x".repeat(5000) + "retained tail";
  const script = "export const meta={name:'long',description:'long'}; return " + JSON.stringify(full);
  if (mode === "cli") {
    writeFileSync(join(dir, "long.js"), script);
    host.setFlag("long.js");
    await host.lifecycle("session_start");
  } else {
    await host.execute({ script });
  }
  await vi.waitFor(() => expect(host.api.sendMessage).toHaveBeenCalled());
  const message = host.api.sendMessage.mock.calls[0][0];
  const path = message.content.match(/Full workflow result: (.+)/)?.[1];
  assert.ok(path);
  artifactDirs.add(dirname(path));
  expect(readFileSync(path, "utf-8")).toBe(full);
  expect(message.content).toContain("...(truncated)");
});

it("reports artifact write failures without losing the expanded result", async () => {
  const host = boot({ workflowsEnabled: true });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const full = "preview\n" + "x".repeat(5000) + "retained tail";
  const result = await host.execute({ script: "export const meta={name:'long',description:'long'}; return " + JSON.stringify(full) });
  const id = result.details?.taskId;
  const scriptPath = result.content[0].text?.match(/Script: (.+)/)?.[1];
  assert.ok(id); assert.ok(scriptPath);
  mkdirSync(join(dirname(scriptPath), `${id}.workflow-result.txt`));
  const message = await host.notification(id);
  expect(message.content).toContain("Warning: Full workflow result could not be saved");
  expect(warn).toHaveBeenCalled();
  const tool = host.tools.get("SubagentWorkflow");
  assert.ok(tool);
  expect(tool.renderResult(result, { expanded: true }, plainTheme, { isError: false }).render(80).join("\n")).toContain("retained tail");
});

it("diagnoses a failed collision check instead of silently ignoring it", async () => {
  const host = boot({ workflowsEnabled: true });
  vi.spyOn(host.api, "getAllTools").mockImplementation(() => { throw new Error("registry failure"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await host.lifecycle("session_start");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Workflow collision check failed"));
  expect(host.tools.has("SubagentWorkflow")).toBe(true);
});
