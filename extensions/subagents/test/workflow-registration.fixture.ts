import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, vi } from "vitest";

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

import { runAgent } from "../src/agent-runner.js";
import extension from "../src/index.js";

type Result = { content: { type: string; text?: string }[]; details?: { taskId?: string }; usage?: ToolResultEvent["usage"] };
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
type Tool = { name: string; description: string; parameters: { properties: Record<string, unknown> }; renderResult(result: Result, options: { expanded: boolean }, theme: typeof plainTheme, context: { isError: boolean }): { render(width: number): string[] }; execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext): Promise<Result> };
type Hook = (event: unknown, ctx: ExtensionContext) => unknown;
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
    model: model as AgentSession["model"], thinkingLevel: "low", dispose: vi.fn(), subscribe: vi.fn(() => vi.fn()),
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

function boot(settings: Record<string, unknown> = {}, sessionId = "parent") {
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
    getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [],
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
  const notification = async (id: string) => {
    await vi.waitFor(() => expect(api.sendMessage.mock.calls.some(([message]) => message.content.includes(`<task-id>${id}</task-id>`))).toBe(true));
    return required(api.sendMessage.mock.calls.find(([message]) => message.content.includes(`<task-id>${id}</task-id>`)))[0];
  };
  const discover = async () => Promise.all((hooks.get("resources_discover") ?? []).map(hook => hook({ type: "resources_discover", cwd: dir, reason: "startup" }, ctx)));
  return { api, ui, tools, ctx, commands, notification, lifecycle, discover,
    setFlag: (value: unknown) => { flag = value; }, setForeign: (value: typeof foreign) => { foreign = value; } };
}

export { artifactDirs, boot, dir, originalCwd, plainTheme, required, session, settingsUI };
