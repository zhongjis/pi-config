import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAccessRules } from "../../lib/active-tools.js";
import { AgentManager } from "../src/agent-manager.js";
import type { OpenSessionOptions } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createDelegateResearchTool } from "../src/research-delegation.js";
import { getStatusNote } from "../src/status-note.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", async (importOriginal) =>
  (await import("./helpers/session-seam.js")).mockOpenSession(await importOriginal()));
vi.mock("../src/turn-ceiling.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/turn-ceiling.js")>(), TURN_CEILING: 10, TURN_CHECK_IN: 3,
}));

import { openSession } from "../src/agent-runner.js";
import { TURN_CEILING, TURN_CEILING_GRACE, TURN_CHECK_IN } from "../src/turn-ceiling.js";
import { fakeSession, opened, type ScriptedSession } from "./helpers/session-seam.js";

const pi = {} as ExtensionAPI;
const ctx = { cwd: tmpdir() } as ExtensionContext;
const parentCwd = tmpdir();

const agent = (name: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name,
  description: name,
  extensionRules: [],
  toolRules: parseAccessRules("tools", "+read").rules,
  discoverSkills: false,
  preloadSkills: [],
  systemPrompt: "",
  promptMode: "replace",
  ...overrides,
});

const PARENT = agent("parent", { allowNesting: true, delegationRules: [{ sign: "+", selector: "leaf" }] });

function setAgents(...configs: AgentConfig[]) {
  registerAgents(new Map(configs.map((config) => [config.name, config])));
}

type ScriptOptions = OpenSessionOptions & { signal: AbortSignal; session: ScriptedSession };
type Script = (options: ScriptOptions) => Promise<string>;

/** Each run follows its type's script; the parent's script drives `delegate_research`. */
function scriptRuns(scripts: Record<string, Script>) {
  vi.mocked(openSession).mockImplementation(async (_ctx, type, options) => opened(fakeSession(async (_prompt, session) => {
    const controller = new AbortController();
    void session.aborted.then(() => controller.abort());
    const text = await (scripts[type]?.({ ...options, signal: controller.signal, session }) ?? Promise.resolve(`${type} answer`));
    return { text, aborted: controller.signal.aborted };
  })));
}

/** One `delegate_research` call from the parent run, with the parent's abort signal as the tool signal. */
async function delegate(options: ScriptOptions, subagentType = "leaf") {
  const { nestedSpawn } = options;
  if (!nestedSpawn) return "no bridge";
  const tool = createDelegateResearchTool("parent", parentCwd, nestedSpawn, () => false);
  const result = await tool.execute("call", { subagent_type: subagentType, prompt: "question", description: "research" }, options.signal, undefined, ctx);
  const [content] = result.content;
  return content?.type === "text" ? content.text : "";
}

const spawnedTypes = () => vi.mocked(openSession).mock.calls.map(([, type]) => type);

let manager: AgentManager;

beforeEach(() => {
  vi.mocked(openSession).mockReset();
  vi.stubEnv("SUBAGENT_TURN_CEILING", String(TURN_CEILING));
  vi.stubEnv("SUBAGENT_TURN_CHECK_IN", String(TURN_CHECK_IN));
  manager = new AgentManager();
});

afterEach(async () => {
  await manager.dispose();
  vi.unstubAllEnvs();
});

describe("delegate_research bridge", () => {
  it("returns the child's final text with its agent id and status", async () => {
    setAgents(PARENT, agent("leaf"));
    scriptRuns({ parent: (options) => delegate(options) });

    const { record } = await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    const child = manager.listAgents().find((candidate) => candidate.type === "leaf");
    expect(record.result).toBe(`agentId: ${child?.id}\ntype: leaf\nstatus: completed\n\nleaf answer`);
  });

  it("gives only the root run an orchestrator check-in", async () => {
    setAgents(PARENT, agent("leaf"));
    const checkIns: Array<[string, number]> = [];
    manager.setCheckInListener((record, threshold) => checkIns.push([record.type, threshold]));
    scriptRuns({
      parent: async (options) => {
        for (let turn = 0; turn < TURN_CHECK_IN; turn++) options.session.turn(true);
        return delegate(options);
      },
      leaf: async (options) => {
        for (let turn = 0; turn < TURN_CHECK_IN; turn++) options.session.turn(true);
        return "leaf answer";
      },
    });

    await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect(checkIns).toEqual([["parent", TURN_CHECK_IN]]);
    expect(manager.listAgents().find((record) => record.type === "leaf")?.turnCount).toBe(TURN_CHECK_IN);
  });

  it("includes the turn-ceiling warning in the result header", async () => {
    setAgents(PARENT, agent("leaf"));
    scriptRuns({ parent: (options) => delegate(options), leaf: async (options) => {
      for (let turn = 0; turn < TURN_CEILING; turn++) options.session.turn(true);
      return "leaf answer";
    } });

    const { record } = await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect(record.result).toContain(`status: force_steered${getStatusNote("force_steered")}\n\nleaf answer`);
  });

  it("identifies a nested turn-ceiling abort in the result header", async () => {
    setAgents(PARENT, agent("leaf"));
    scriptRuns({ parent: (options) => delegate(options), leaf: async (options) => {
      for (let turn = 0; turn < TURN_CEILING + TURN_CEILING_GRACE; turn++) options.session.turn(true);
      await options.session.aborted;
      return "partial leaf answer";
    } });

    const { record } = await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect(record.result).toContain(`status: aborted${getStatusNote("aborted", "turn-limit")}\n\npartial leaf answer`);
  });

  it("runs the child in the parent's working directory without inherited context", async () => {
    setAgents(PARENT, agent("leaf"));
    scriptRuns({ parent: (options) => delegate(options) });

    await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect(vi.mocked(openSession).mock.calls[1]?.[2]).toMatchObject({ cwd: parentCwd, inheritContext: false });
  });

  it("consumes the nested completion so the root receives no notification", async () => {
    const completed: AgentRecord[] = [];
    await manager.dispose();
    manager = new AgentManager((record) => completed.push({ ...record }));
    setAgents(PARENT, agent("leaf"));
    scriptRuns({ parent: (options) => delegate(options) });

    await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect(completed.find((record) => record.type === "leaf")?.resultConsumed).toBe(true);
  });

  it("gives a nested run no bridge of its own", async () => {
    setAgents(PARENT, agent("leaf"));
    scriptRuns({ parent: (options) => delegate(options), leaf: async (options) => (options.nestedSpawn ? "bridge" : "no bridge") });

    const { record } = await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect(record.result).toMatch(/\n\nno bridge$/);
  });

  it("gives a graph-owned run no bridge", async () => {
    setAgents(PARENT, agent("leaf"));
    scriptRuns({ parent: async (options) => (options.nestedSpawn ? "bridge" : "no bridge") });

    const id = manager.spawn(pi, ctx, "parent", "go", { description: "parent", graphRunId: "agr_graph" });
    await manager.getRecord(id)?.promise;

    expect(manager.getRecord(id)?.result).toBe("no bridge");
  });

  it.each<[string, AgentConfig[], string]>([
    ["a target outside the allowlist", [agent("parent", { allowNesting: true, delegationRules: [{ sign: "+", selector: "other" }] }), agent("leaf"), agent("other")], "leaf"],
    ["an empty allowlist", [agent("parent", { allowNesting: true, delegationRules: [] }), agent("leaf")], "leaf"],
    ["a nesting target", [PARENT, agent("leaf", { allowNesting: true })], "leaf"],
    ["the parent's own type", [agent("parent", { allowNesting: true, delegationRules: [{ sign: "+", selector: "parent" }] })], "parent"],
    ["an editing target", [PARENT, agent("leaf", { toolRules: parseAccessRules("tools", "+read, +edit").rules })], "leaf"],
    ["an unguarded Bash target", [PARENT, agent("leaf", { toolRules: parseAccessRules("tools", "+read, +bash").rules })], "leaf"],
    ["an unknown target", [PARENT], "leaf"],
    ["a disabled target", [PARENT, agent("leaf", { enabled: false })], "leaf"],
    ["an append-mode target", [PARENT, agent("leaf", { promptMode: "append" })], "leaf"],
  ])("denies %s without spawning", async (_label, configs, target) => {
    setAgents(...configs);
    scriptRuns({ parent: (options) => delegate(options, target) });

    const { record } = await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect({ result: record.result, spawned: spawnedTypes() }).toMatchObject({
      result: expect.stringContaining("status: denied\nerror:"),
      spawned: ["parent"],
    });
  });

  it("returns the root mode-policy denial without spawning", async () => {
    setAgents(PARENT, agent("leaf"));
    manager.setPolicyChecker((_ctx, type) => (type === "leaf" ? "delegation_policy_denied: leaf is not permitted" : undefined));
    scriptRuns({ parent: (options) => delegate(options) });

    const { record } = await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect({ result: record.result, spawned: spawnedTypes() }).toMatchObject({
      result: expect.stringContaining("error: delegation_policy_denied: leaf is not permitted"),
      spawned: ["parent"],
    });
  });

  it("denies a fourth concurrent call instead of queuing it", async () => {
    setAgents(PARENT, agent("leaf"));
    let release = () => {};
    const leafGate = new Promise<void>((resolve) => { release = resolve; });
    scriptRuns({
      parent: async (options) => {
        const calls = [delegate(options), delegate(options), delegate(options)];
        const fourth = await delegate(options);
        release();
        await Promise.all(calls);
        return fourth;
      },
      leaf: async () => { await leafGate; return "leaf answer"; },
    });

    const { record } = await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect({ result: record.result, spawned: spawnedTypes() }).toMatchObject({
      result: expect.stringContaining("status: denied\nerror: At most 3"),
      spawned: ["parent", "leaf", "leaf", "leaf"],
    });
  });

  it("completes a foreground parent and its nested child with one foreground slot", async () => {
    manager.setMaxConcurrentForeground(1);
    setAgents(PARENT, agent("leaf"));
    scriptRuns({ parent: (options) => delegate(options) });

    const { record } = await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    expect(record.result).toMatch(/status: completed\n\nleaf answer$/);
  });

  it("starts the nested run while its background parent holds the only background slot", async () => {
    await manager.dispose();
    manager = new AgentManager(undefined, 1);
    setAgents(PARENT, agent("leaf"));
    let leafStatus: AgentRecord["status"] | undefined;
    scriptRuns({
      parent: (options) => {
        const pending = delegate(options);
        leafStatus = manager.listAgents().find((candidate) => candidate.type === "leaf")?.status;
        return pending;
      },
    });

    const id = manager.spawn(pi, ctx, "parent", "go", { description: "parent", isBackground: true });
    await manager.getRecord(id)?.promise;

    expect(leafStatus).toBe("running");
    expect(manager.getRecord(id)?.result).toMatch(/status: completed\n\nleaf answer$/);
  });

  it("stops only the nested run, as a caller cancellation, when the tool's signal aborts", async () => {
    setAgents(PARENT, agent("leaf"));
    const toolSignal = new AbortController();
    scriptRuns({
      parent: (options) => delegate({ ...options, signal: toolSignal.signal }),
      leaf: (options) => new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve("partial"), { once: true });
        toolSignal.abort();
      }),
    });

    const { record } = await manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" });

    const child = manager.listAgents().find((candidate) => candidate.type === "leaf");
    expect(child).toMatchObject({ status: "stopped", interruptionCause: "caller", result: "partial" });
    expect(record.status).toBe("completed");
    expect(record.result).toContain(`status: stopped${getStatusNote("stopped", "caller")}\n\npartial`);
  });

  it("aborts the nested run when the parent aborts", async () => {
    setAgents(PARENT, agent("leaf"));
    let parentId = "";
    scriptRuns({
      parent: (options) => delegate(options),
      leaf: (options) => new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve("partial"), { once: true });
        setTimeout(() => manager.abort(parentId, "user"), 0);
      }),
    });

    const parent = manager.spawnAndWait(pi, ctx, "parent", "go", { description: "parent" }, (id) => { parentId = id; });
    await parent;

    expect(manager.listAgents().find((candidate) => candidate.type === "leaf")?.status).toBe("stopped");
  });
});
