import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { runWorkflow, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

const ui: Pick<ExtensionContext["ui"], "notify"> = { notify: vi.fn() };
const ctxFixture: Partial<ExtensionContext> = {
  cwd: "/tmp", modelRegistry: {} as ExtensionContext["modelRegistry"], model: undefined,
  sessionManager: { getSessionId: () => "parent" } as ExtensionContext["sessionManager"],
  ui: ui as ExtensionContext["ui"],
};
const ctx = ctxFixture as ExtensionContext;
const session = () => {
  const fixture: Pick<AgentSession, "dispose"> = { dispose: vi.fn() };
  return fixture as AgentSession;
};
const request: WorkflowSpawnRequest = { agentId: "child", index: 0, prompt: "task", label: "child", agentType: "general-purpose" };
const head = 'export const meta = { name: "probe", description: "probe" };\n';
let manager: AgentManager;
afterEach(() => { manager?.dispose(); vi.resetAllMocks(); });

function setup() {
  manager = new AgentManager();
  const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: "passed", stderr: "", killed: false });
  const pi: Pick<ExtensionAPI, "exec"> = { exec };
  const host = createWorkflowHost({ pi: pi as ExtensionAPI, ctx, manager, workflowId: "workflow", outputTranscript: () => false });
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    options.onAssistantUsage?.({ input: 5, output: 3, cacheWrite: 0, cacheRead: 8, cost: 0.1 });
    return { session: session(), responseText: "done", aborted: false, steered: false };
  });
  return { host, exec };
}

describe("local workflow host", () => {
  it("enforces delegation policy before child creation", async () => {
    const { host } = setup();
    manager.setPolicyChecker(() => "denied by policy");
    expect(await host.spawnAgent(request)).toMatchObject({ ok: false, error: "denied by policy" });
    expect(runAgent).not.toHaveBeenCalled();
    expect(manager.listAgents()).toEqual([]);
    await host.dispose?.();
  });

  it.each(["worktree", "none", undefined])("rejects isolation %s even at the direct host boundary", async isolation => {
    const { host } = setup();
    expect(await host.spawnAgent({ ...request, isolation })).toMatchObject({ ok: false, error: expect.stringContaining("no isolation backend") });
    expect(runAgent).not.toHaveBeenCalled();
    await host.dispose?.();
  });

  it("gates successful children in effective cwd, retaining accounting and sessions after cleanup", async () => {
    const { host, exec } = setup();
    const result = await runWorkflow({ script: head + 'return await agent("task", { gate: "test -d ." });', host });
    expect(result.value).toBe("done");
    expect(exec).toHaveBeenCalledWith("sh", ["-c", "test -d ."], expect.objectContaining({ cwd: "/tmp", timeout: 600000 }));
    expect(manager.listAgents()).toHaveLength(1);
    const record = manager.listAgents()[0];
    expect(record.workflowId).toBe("workflow");
    expect(record.lifetimeUsage).toMatchObject({ output: 3, cacheRead: 8 });
    expect(record.session).toBeDefined();
    expect(manager.getLifetimeCost()).toBe(0.1);
  });

  it("does not gate unsuccessful children", async () => {
    const { host, exec } = setup();
    vi.mocked(runAgent).mockResolvedValue({ session: session(), responseText: "bad", failure: "provider failed", aborted: false, steered: false });
    const result = await runWorkflow({ script: head + 'return await agent("task", { gate: "false" });', host });
    expect(result.value).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects gated answers while preserving usage when command execution throws", async () => {
    const { host, exec } = setup();
    exec.mockRejectedValue(new Error("shell failed"));
    const result = await runWorkflow({ script: head + 'const answer = await agent("task", { gate: "false" }); return { answer, spent: budget.spent() };', host });
    expect(result.value).toEqual({ answer: null, spent: 3 });
    expect(result.progress.at(-1)).toMatchObject({ state: "error", error: "shell failed" });
  });

  it("resumes the owned session, enforces current policy, and returns incremental usage", async () => {
    const { host } = setup();
    await host.spawnAgent(request);
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options) => {
      options?.onAssistantUsage?.({ input: 1, output: 2, cacheWrite: 0 });
      return { text: "resumed", structuredJson: '{"answer":"new"}', structuredRetried: true };
    });
    expect(await host.resumeAgent?.("child", "next")).toMatchObject({ ok: true, text: '{"answer":"new"}', outputTokens: 2, tokens: 3 });
    manager.setPolicyChecker(() => "resume denied");
    await expect(host.resumeAgent?.("child", "again")).rejects.toThrow("resume denied");
    await host.dispose?.();
  });

  it("abort during a gate stops and awaits the gate before workflow settlement", async () => {
    const { host, exec } = setup();
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const gateStarted = new Promise<void>(resolve => { started = resolve; });
    let stopped = false;
    exec.mockImplementation(async (_command, _args, options) => {
      started?.();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
      return { code: 1, stdout: "", stderr: "aborted", killed: true };
    });
    const pending = runWorkflow({ script: head + 'return await agent("task", { gate: "wait" });', host, signal: controller.signal });
    await gateStarted;
    controller.abort();
    expect((await pending).status).toBe("killed");
    expect(stopped).toBe(true);
  });
});

describe("workflow gate shell smoke", () => {
  it("runs a real shell command in the effective cwd", async () => {
    const { host, exec } = setup();
    exec.mockImplementation(async (command, args, options) => {
      const { stdout, stderr } = await promisify(execFile)(command, args, { cwd: options?.cwd, signal: options?.signal, timeout: options?.timeout });
      return { code: 0, stdout, stderr, killed: false };
    });
    await host.spawnAgent(request);
    expect(await host.runGate?.("printf '%s' \"$PWD\"", { agentId: "child", cwd: "/tmp" })).toEqual({ ok: true, output: "/tmp" });
    await host.dispose?.();
  });
});
