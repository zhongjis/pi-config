/** Foreground identity must reach the model through content, not just renderer details. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { BootedPi } from "./helpers/boot-extension.js";
import { perfSession } from "./helpers/perf-fixtures.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

async function runForegroundSteeredAgent(
  tools: BootedPi["tools"],
  status: "completed" | "steered" | "stopped" | "aborted" | "error" = "steered",
) {
  const session = perfSession();
  const controller = new AbortController();
  vi.mocked(runAgent).mockImplementation(async () => {
    if (status === "stopped") controller.abort();
    return {
      responseText: "THE-RESULT-PAYLOAD",
      session,
      aborted: status === "aborted",
      steered: status === "steered",
      failure: status === "error" ? "provider failed" : undefined,
    };
  });
  const res = await tools.get("Agent").execute(
    "tc-fg",
    {
      prompt: "Perform a very thorough read-only codebase exploration.",
      description: "Locate organization-scope changes",
      subagent_type: "Explore",
      max_turns: 20,
      run_in_background: false,
    },
    controller.signal,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(res))?.[1];
  if (!id) throw new Error("Foreground content did not supply an Agent ID");
  return { res, id, session };
}

describe("issue #174: foreground agent that hits max_turns", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir, scheduling off — same isolation as
    // clear-completed-wiring.test.ts, so session_start doesn't spin a
    // scheduler or touch the dev's filesystem.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-174-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-174-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is NOT cleaned up — get_subagent_result with the real id still resolves it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { res, id } = await runForegroundSteeredAgent(tools);

    // The inline result is the turn-limit wrap-up the reporter described.
    expect(textOf(res)).toContain("wrapped up at the turn limit");

    // No /new, no /resume, no session switch — exactly the reporter's sequence.
    const read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it.each(["completed", "steered", "stopped", "aborted", "error"] as const)(
    "returns an ID in %s content that retrieves and resumes the original session",
    async (status) => {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      try {
        vi.mocked(runAgent).mockClear();
        const { res, id, session } = await runForegroundSteeredAgent(tools, status);
        expect(res.details).toMatchObject({ agentId: id, status });
        expect(textOf(res)).toContain("THE-RESULT-PAYLOAD");
        const read = await tools.get("get_subagent_result").execute(
          "tc-read", { agent_id: id }, undefined, undefined, ctx(),
        );
        expect(textOf(read)).toContain(`Agent: ${id}`);
        expect(textOf(read)).toContain("THE-RESULT-PAYLOAD");

        for (const failure of [undefined, "resume failed"]) {
          vi.mocked(resumeAgent).mockResolvedValue({ text: "CONTINUED-PAYLOAD", failure });
          const resumed = await tools.get("Agent").execute(
            "tc-resume",
            { resume: id, prompt: "continue", description: "Continue work", subagent_type: "Explore", run_in_background: false },
            undefined, undefined, ctx(),
          );
          expect(/Agent ID: (\S+)/.exec(textOf(resumed))?.[1]).toBe(id);
          expect(textOf(resumed)).toContain("CONTINUED-PAYLOAD");
          expect(resumed.details).toMatchObject({ agentId: id, status: failure ? "error" : "completed" });
          expect(resumeAgent).toHaveBeenLastCalledWith(session, "continue", expect.any(Object));
        }
        expect(runAgent).toHaveBeenCalledTimes(1);
      } finally {
        await lifecycle.get("session_shutdown")?.({}, ctx());
      }
    },
  );

  it("survives a subagent session's OWN activation lifecycle (adversarial: cross-activation eviction)", async () => {
    // The one mechanism that could produce the reported symptom with no
    // user-visible session change: a second activation of this extension in the
    // same process. Child sessions no longer reach it — activation returns early
    // under `inChildSessionContext()` — but any other in-process activation still
    // can, and if its session_start / session_shutdown reached the PARENT's
    // manager, that activation ending would wipe the parent's records.
    const parent = makePi();
    subagentsExtension(parent.pi);
    await parent.lifecycle.get("session_start")?.({}, ctx());
    const { id } = await runForegroundSteeredAgent(parent.tools);

    // A child activation runs its full lifecycle, as a subagent session does.
    const child = makePi();
    subagentsExtension(child.pi);
    await child.lifecycle.get("session_start")?.({}, ctx());
    await child.lifecycle.get("session_shutdown")?.({}, ctx());

    // The parent's record must be untouched — separate manager per activation.
    const read = await parent.tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await parent.lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("IS evicted by a session switch — its result was already delivered inline", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { id } = await runForegroundSteeredAgent(tools);

    // Foreground results count as consumed the moment they're returned inline,
    // so clearCompleted(true)'s #108 preservation deliberately does not cover
    // them. This is the ONLY path that makes a foreground id stop resolving.
    await lifecycle.get("session_before_switch")?.();

    const read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(read)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
