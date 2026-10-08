import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession, loaderOptions } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  loaderOptions: [] as Array<{ noExtensions?: boolean; systemPromptOverride?: () => string }>,
}));

// Real runner and manager; only session construction is faked so the declared tool set is observable.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: (typeof loaderOptions)[number]) { loaderOptions.push(options); }
    async reload() {}
  },
  SessionManager: { create: () => ({ appendCustomEntry: vi.fn(), getSessionId: () => "child-session" }) },
  SettingsManager: { create: () => ({ getSessionDir: () => undefined }) },
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

import { AgentManager, type SpawnOptions } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { loadGraphClassifierAgent } from "../src/builtin-agents.js";
import { type EventBus, registerRpcHandlers } from "../src/cross-extension-rpc.js";
import type { CompiledSchema } from "../src/graph/json-schema.js";
import type { AgentConfig } from "../src/types.js";

const schema: CompiledSchema = {
  schema: { type: "object", properties: { p: { type: "number" } }, required: ["p"] },
  providerSchema: { type: "object", properties: { p: { type: "number" } }, required: ["p"] },
  check: (value) => typeof (value as { p?: unknown })?.p === "number" ? true : "p must be a number",
};
const callerModel = { provider: "fixture", id: "exact" } as any;
const ctx = {
  cwd: tmpdir(),
  model: { provider: "fixture", id: "parent" },
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: () => "PARENT PROMPT",
} as any;
const pi = {} as any;

function fakeSession() {
  const session = {
    messages: [] as any[],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {
      const tool = createAgentSession.mock.calls.at(-1)?.[0].customTools?.[0];
      if (tool) await tool.execute("call", { p: 0.5 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
    }),
    waitForIdle: vi.fn(async () => {}),
    abort: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return session;
}

const lastSessionOptions = () => createAgentSession.mock.calls.at(-1)?.[0];

let dir: string;
let manager: AgentManager;

function writeAgent(name: string, frontmatter: string, body = "Fixture classifier prompt."): string {
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`);
  return path;
}

const validFrontmatter = "prompt_mode: replace\nisolated: true\ndiscover_skills: false\nmax_turns: 2";

function userAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: name,
    extensionRules: [{ sign: "+", selector: "@all" }],
    toolRules: [{ sign: "+", selector: "@all" }],
    discoverSkills: true,
    preloadSkills: [],
    model: "fixture/user-model",
    systemPrompt: "USER AGENT PROMPT",
    promptMode: "append",
    inheritContext: true,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "internal-agent-"));
  createAgentSession.mockReset();
  createAgentSession.mockImplementation(async () => ({ session: fakeSession() }));
  loaderOptions.length = 0;
  registerAgents(new Map());
  manager = new AgentManager();
});

afterEach(async () => {
  await manager.dispose();
  registerAgents(new Map());
  rmSync(dir, { recursive: true, force: true });
});

describe("loadGraphClassifierAgent", () => {
  it("loads the shipped definition as an isolated, tool-free, model-free config", () => {
    const config = loadGraphClassifierAgent();
    expect(config).toMatchObject({ toolRules: [], extensionRules: [], promptMode: "replace", isolated: true });
    expect(config.model).toBeUndefined();
    expect(config.thinking).toBeUndefined();
    expect(config.inheritContext).not.toBe(true);
    expect(loadGraphClassifierAgent()).toBe(config);
  });

  it.each([
    ["model", `${validFrontmatter}\nmodel: fixture/any`],
    ["thinking", `${validFrontmatter}\nthinking: high`],
    ["tools", `${validFrontmatter}\ntools: +read`],
    ["extensions", `${validFrontmatter}\nextensions: +@all`],
    ["isolation", "prompt_mode: replace\ndiscover_skills: false"],
    ["prompt mode", "prompt_mode: append\nisolated: true"],
    ["inherited context", `${validFrontmatter}\ninherit_context: true`],
    ["invalid field", `${validFrontmatter}\nskills: none`],
  ])("fails closed on %s", (_label, frontmatter) => {
    expect(() => loadGraphClassifierAgent(writeAgent("bad", frontmatter))).toThrow(/Invalid built-in agent/);
  });

  it("accepts a conforming synthetic definition", () => {
    expect(loadGraphClassifierAgent(writeAgent("ok", validFrontmatter))).toMatchObject({ name: "ok", source: "default" });
  });
});

describe("spawnInternalAndWait", () => {
  const spawnInternal = (config: AgentConfig, options: Partial<SpawnOptions> = {}) =>
    manager.spawnInternalAndWait(pi, ctx, config, "classify", {
      description: "decide",
      graphRunId: "agr_fixture",
      model: callerModel,
      selectedModel: { model: callerModel },
      thinkingLevel: "low",
      structuredOutput: schema,
      ...options,
    });

  it("declares exactly StructuredOutput on the caller's exact model", async () => {
    const config = loadGraphClassifierAgent(writeAgent("classifier", validFrontmatter));
    const { record } = await spawnInternal(config, { inheritContext: true, isolated: false, skills: ["x"] });

    expect(record.status).toBe("completed");
    expect(record.structuredJson).toBe('{"p":0.5}');
    const options = lastSessionOptions();
    expect(options.tools).toEqual(["StructuredOutput"]);
    expect(options.customTools.map((tool: { name: string }) => tool.name)).toEqual(["StructuredOutput"]);
    expect(options.excludeTools).toBeUndefined();
    expect(options.model).toBe(callerModel);
    expect(options.thinkingLevel).toBe("low");
    expect(loaderOptions.at(-1)?.noExtensions).toBe(true);
  });

  it("runs while the delegation policy denies every agent", async () => {
    manager.setPolicyChecker(() => "delegation_policy_denied: everything");
    registerAgents(new Map([["worker", userAgent("worker")]]));
    const config = loadGraphClassifierAgent(writeAgent("classifier", validFrontmatter));

    await expect(manager.spawnAndWait(pi, ctx, "worker", "go", { description: "worker" }))
      .rejects.toThrow(/delegation_policy_denied/);
    const { record } = await spawnInternal(config);
    expect(record.status).toBe("completed");
  });

  it("ignores a registered user agent with the same name", async () => {
    const config = loadGraphClassifierAgent(writeAgent("classifier", validFrontmatter, "FIXTURE CLASSIFIER PROMPT"));
    registerAgents(new Map([["classifier", userAgent("classifier")]]));

    await spawnInternal(config);

    const options = lastSessionOptions();
    expect(options.tools).toEqual(["StructuredOutput"]);
    expect(options.model).toBe(callerModel);
    expect(loaderOptions.at(-1)?.noExtensions).toBe(true);
    const prompt = loaderOptions.at(-1)?.systemPromptOverride?.() ?? "";
    expect(prompt).toContain("FIXTURE CLASSIFIER PROMPT");
    expect(prompt).not.toContain("USER AGENT PROMPT");
    expect(prompt).not.toContain("PARENT PROMPT");
  });
});

describe("cross-extension RPC spawn", () => {
  it("cannot carry an agentConfig override", async () => {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    const events: EventBus = {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)?.add(handler);
        return () => { listeners.get(event)?.delete(handler); };
      },
      emit(event, data) { for (const handler of listeners.get(event) ?? []) handler(data); },
    };
    registerAgents(new Map([["worker", userAgent("worker", {
      extensionRules: [], toolRules: [{ sign: "+", selector: "read" }], model: undefined, promptMode: "replace", inheritContext: undefined,
    })]]));
    registerRpcHandlers({ events, pi: { events }, getCtx: () => ctx, manager });
    const reply = vi.fn();
    events.on("subagents:rpc:spawn:reply:req-1", reply);

    events.emit("subagents:rpc:spawn", {
      requestId: "req-1",
      type: "worker",
      prompt: "go",
      options: { description: "rpc", agentConfig: userAgent("evil", { extensionRules: [], toolRules: [{ sign: "+", selector: "bash" }] }) },
    });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    const id = reply.mock.calls[0]?.[0]?.data?.id as string;
    await manager.getRecord(id)?.promise;
    expect(lastSessionOptions().tools).toEqual(["read"]);
    expect(loaderOptions.at(-1)?.systemPromptOverride?.()).toContain("USER AGENT PROMPT");
  });
});
