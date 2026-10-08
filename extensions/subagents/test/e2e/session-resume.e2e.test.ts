/**
 * session-resume.e2e.test.ts — real Pi child session files: a fresh spawn
 * persists a resumable transcript, a reopen continues that same conversation,
 * and a refused reopen leaves the file untouched.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxText, type Message } from "@earendil-works/pi-ai";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, disposeChildSession } from "../../src/agent-manager.js";
import { runAgent, SUBAGENT_LAUNCH_ENTRY } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig, EvictedAgent } from "../../src/types.js";
import { createFauxModelRuntime, type FauxModelRuntime } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const AGENT_TYPE = "resume-probe";
const AGENT_ID = "agent-1";
const PARENT_ID = "parent-1";
const LAUNCH = { version: 1, agentId: AGENT_ID, type: AGENT_TYPE };

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("subagent session resume against real pi-mono", () => {
  let root: string;
  let sessionsDir: string;
  let parentFile: string;
  let fauxRuntime: FauxModelRuntime;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "subagents-resume-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent-dir"));
    sessionsDir = join(root, "agent-dir", "subagent-sessions", PARENT_ID);
    parentFile = join(root, "parent.jsonl");
    registerAgents(new Map([[AGENT_TYPE, {
      name: AGENT_TYPE,
      description: AGENT_TYPE,
      extensionRules: [],
      toolRules: [],
      discoverSkills: false,
      preloadSkills: [],
      systemPrompt: "You are a resume probe.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    } satisfies AgentConfig]]));
    fauxRuntime = await createFauxModelRuntime({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    fauxRuntime.dispose();
    registerAgents(new Map());
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function parentCtx(): any {
    const { model, modelRegistry } = fauxRuntime;
    return {
      cwd: root,
      getSystemPrompt: () => "PARENT",
      model,
      modelRegistry,
      sessionManager: { getSessionFile: () => parentFile, getSessionId: () => PARENT_ID, getBranch: () => [] },
    };
  }

  function run(prompt: string, options: { resumeSessionFile?: string; onSessionCreated?: (session: AgentSession) => void } = {}) {
    return runAgent(parentCtx(), AGENT_TYPE, prompt, {
      pi: makePi(),
      model: fauxRuntime.model,
      agentId: AGENT_ID,
      parentSessionId: PARENT_ID,
      ...options,
    });
  }

  /** Write a persisted child session through Pi's own SessionManager. */
  function writeChild(options: { launch?: Record<string, unknown>; parentSession?: string; cwd?: string } = {}): string {
    const sessionManager = SessionManager.create(options.cwd ?? root, sessionsDir, { parentSession: options.parentSession ?? parentFile });
    if (options.launch) sessionManager.appendCustomEntry(SUBAGENT_LAUNCH_ENTRY, options.launch);
    sessionManager.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
    const file = sessionManager.getSessionFile();
    if (!file) throw new Error("fixture session was not persisted");
    return file;
  }

  it("resuming from the file continues the same conversation in the same file", async () => {
    let first: AgentSession | undefined;
    fauxRuntime.faux.setResponses([fauxAssistantMessage([fauxText("FIRST")])]);
    await run("remember ALPHA", { onSessionCreated: (session) => { first = session; } });
    const file = first?.sessionManager.getSessionFile();
    if (!first || !file) throw new Error("fresh spawn did not persist a session file");
    await disposeChildSession(first);
    const sizeBefore = statSync(file).size;

    const requested: string[] = [];
    fauxRuntime.faux.setResponses([(context) => {
      for (const message of context.messages) {
        if (message.role === "user" || message.role === "assistant") requested.push(`${message.role}:${messageText(message)}`);
      }
      return fauxAssistantMessage([fauxText("SECOND")]);
    }]);
    let resumed: AgentSession | undefined;
    const result = await run("what did I ask?", { resumeSessionFile: file, onSessionCreated: (session) => { resumed = session; } });
    if (resumed) await disposeChildSession(resumed);

    expect({
      requested,
      responseText: result.responseText,
      files: readdirSync(sessionsDir),
      grew: statSync(file).size > sizeBefore,
    }).toEqual({
      requested: ["user:remember ALPHA", "assistant:FIRST", "user:what did I ask?"],
      responseText: "SECOND",
      files: [basename(file)],
      grew: true,
    });
  });

  it("a manager restores an evicted run from its file and continues the conversation", async () => {
    const manager = new AgentManager();
    try {
      fauxRuntime.faux.setResponses([fauxAssistantMessage([fauxText("FIRST")])]);
      const { record } = await manager.spawnAndWait(makePi(), parentCtx(), AGENT_TYPE, "remember ALPHA", { description: "probe", model: fauxRuntime.model });
      const { id, type, description, startedAt, completedAt, toolUses, lifetimeUsage, sessionFile } = record;
      if (!sessionFile) throw new Error("spawned run did not persist a session file");
      const run: EvictedAgent = { id, type, description, status: "completed", startedAt, completedAt, toolUses, lifetimeUsage, sessionFile };
      manager.clearCompleted();
      manager.setEvictedIndex((lookup) => (lookup === id ? run : undefined));
      const requested: string[] = [];
      fauxRuntime.faux.setResponses([(context) => {
        for (const message of context.messages) {
          if (message.role === "user" || message.role === "assistant") requested.push(`${message.role}:${messageText(message)}`);
        }
        return fauxAssistantMessage([fauxText("SECOND")]);
      }]);

      const restored = await manager.restoreEvicted(makePi(), parentCtx(), id, "what did I ask?");

      expect({ requested, result: restored.result }).toEqual({
        requested: ["user:remember ALPHA", "assistant:FIRST", "user:what did I ask?"],
        result: "SECOND",
      });
    } finally {
      await manager.dispose();
    }
  });

  it("S6 refuses a missing file without creating it", async () => {
    const file = join(root, "missing.jsonl");

    await expect(run("go", { resumeSessionFile: file })).rejects.toThrow(/missing or empty/);

    expect(existsSync(file)).toBe(false);
  });

  it("S6 refuses an empty file without writing a header into it", async () => {
    const file = join(root, "empty.jsonl");
    writeFileSync(file, "");

    await expect(run("go", { resumeSessionFile: file })).rejects.toThrow(/missing or empty/);

    expect(statSync(file).size).toBe(0);
  });

  it("S6 refuses non-session content without modifying it", async () => {
    const file = join(root, "notes.jsonl");
    writeFileSync(file, "not a pi session\nsecond line");

    await expect(run("go", { resumeSessionFile: file })).rejects.toThrow(/not a valid .*session/);

    expect(readFileSync(file, "utf8")).toBe("not a pi session\nsecond line");
  });

  it("S7 refuses a session header without conversation messages", async () => {
    const file = join(root, "header-only.jsonl");
    writeFileSync(file, `${JSON.stringify(SessionManager.create(root, sessionsDir).getHeader())}\n`);

    await expect(run("go", { resumeSessionFile: file })).rejects.toThrow(/has no conversation/);
  });

  it.each([
    ["the launch entry is missing", () => ({}), /has no subagent-launch entry/],
    ["the launch agentId differs", () => ({ launch: { ...LAUNCH, agentId: "agent-2" } }), /different agent/],
    ["the launch type differs", () => ({ launch: { ...LAUNCH, type: "other-probe" } }), /different agent/],
    ["the header parentSession differs", () => ({ launch: LAUNCH, parentSession: join(root, "other-parent.jsonl") }), /different parent session/],
    ["the header cwd is gone", () => ({ launch: LAUNCH, cwd: join(root, "gone") }), /working directory .* does not exist/],
  ] as const)("S7 refuses a session when %s", async (_case, fixture, error) => {
    const file = writeChild(fixture());

    await expect(run("go", { resumeSessionFile: file })).rejects.toThrow(error);
  });
});
