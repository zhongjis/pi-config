/**
 * foreground-result-retrieval.test.ts — issue #174, via the REAL Agent,
 * get_agent_result, and resume paths.
 *
 * A foreground agent that wraps up at the turn ceiling keeps its record available.
 * Its exact Agent ID must stay available in model-visible content, not only
 * renderer details.
 *
 * These tests pin three lifecycle guarantees:
 *
 *   1. Foreground completion does not clean up the record.
 *   2. The foreground result exposes the real ID and that ID resumes.
 *   3. Session switching still evicts consumed foreground records.
 *
 * The turn-ceiling shape stays covered because issue #174 occurred after a
 * graceful turn-ceiling wrap-up (`status: "force_steered"`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async (importOriginal) =>
  (await import("./helpers/session-seam.js")).mockOpenSession(await importOriginal()));

import { openSession } from "../src/agent-runner.js";
import { fakeSession, opened } from "./helpers/session-seam.js";

vi.mock("../src/turn-ceiling.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/turn-ceiling.js")>(),
  TURN_CEILING: 3,
  TURN_CHECK_IN: 100,
}));

import subagentsExtension from "../src/index.js";
import { getForegroundOutcomeNote } from "../src/status-note.js";
import { TURN_CEILING, TURN_CHECK_IN } from "../src/turn-ceiling.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
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
  const model = { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" };
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(() => model), getAvailable: vi.fn(() => [model]) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

/**
 * Run a FOREGROUND agent that wraps up at the turn ceiling — the exact #174
 * shape. Unfinished SDK turns drive the real watch into status "force_steered",
 * which produces the reporter's turn-ceiling completion note.
 *
 * Returns the tool result plus the authoritative ID from structured details
 * so tests can compare it with the model-visible handle.
 */
async function runForegroundSteeredAgent(tools: Map<string, any>) {
  const session = fakeSession(() => {
    for (let turn = 0; turn < TURN_CEILING; turn++) session.turn(true);
    return "THE-RESULT-PAYLOAD";
  });
  vi.mocked(openSession).mockResolvedValue(opened(session));
  const res = await tools.get("agent").execute(
    "tc-fg",
    {
      prompt: "Perform a very thorough read-only codebase exploration.",
      description: "Locate organization-scope changes",
      subagent_type: "Explore",
    },
    undefined,
    undefined,
    ctx(),
  );
  const id = (res as any).details?.agentId as string | undefined;
  expect(id, "foreground spawn should have produced a record id in details").toBeTruthy();
  return { res, id: id as string, session };
}

describe("issue #174: foreground agent that hits the turn ceiling", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    vi.stubEnv("SUBAGENT_TURN_CEILING", String(TURN_CEILING));
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", String(TURN_CHECK_IN));
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
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is NOT cleaned up — get_agent_result with the real id still resolves it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { res, id } = await runForegroundSteeredAgent(tools);

    // The inline result is the turn-ceiling wrap-up the reporter described.
    expect(textOf(res)).toContain(getForegroundOutcomeNote("force_steered"));

    // No /new, no /resume, no session switch — exactly the reporter's sequence.
    const read = await tools.get("get_agent_result").execute("tc-read", { run_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("hands the model the real agent id and that id resumes", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { res, id, session } = await runForegroundSteeredAgent(tools);

    expect(textOf(res)).toContain(`Agent ID: ${id}`);

    session.prompt.mockImplementationOnce(async () => { session.reply({ text: "RESUMED-PAYLOAD" }); });
    const openingCount = vi.mocked(openSession).mock.calls.length;
    const resumed = await tools.get("agent").execute(
      "tc-resume",
      {
        prompt: "Continue from the previous result.",
        description: "Continue organization-scope changes",
        subagent_type: "Explore",
        resume: id,
      },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(resumed)).toBe("RESUMED-PAYLOAD");
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.prompt.mock.calls[1]?.[0]).toContain("Continue from the previous result.");
    expect(openSession).toHaveBeenCalledTimes(openingCount);

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("survives a subagent session's OWN activation lifecycle (adversarial: cross-activation eviction)", async () => {
    // The one mechanism that could produce the reported symptom with no
    // user-visible session change: subagent sessions re-activate this extension
    // in the same process (session.bindExtensions in agent-runner.ts). If a
    // child activation's session_start / session_shutdown reached the PARENT's
    // manager, a finishing subagent would wipe the parent's records.
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
    const read = await parent.tools.get("get_agent_result").execute("tc-read", { run_id: id }, undefined, undefined, ctx());
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

    const read = await tools.get("get_agent_result").execute("tc-read", { run_id: id }, undefined, undefined, ctx());
    expect(textOf(read)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
