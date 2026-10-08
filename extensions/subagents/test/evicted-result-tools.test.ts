/**
 * evicted-result-tools.test.ts — get_agent_result and steer_subagent for a run
 * that left the live map but remains in the agent-history index: read-only
 * reports from the persisted transcript, never a new live record.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { createAgentResultBuilder } from "../src/agent-result.js";
import { registerAgents } from "../src/agent-types.js";
import { createResultTools } from "../src/result-tools.js";
import type { EvictedAgent } from "../src/types.js";

const PARENT_ID = "parent-1";
const pi = { events: { emit: vi.fn() } } as any;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";

describe("tools on an evicted, indexed agent", () => {
  let root: string;
  let sessionsDir: string;
  let ctx: any;
  let manager: AgentManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "evicted-result-tools-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent-dir"));
    sessionsDir = join(root, "agent-dir", "subagent-sessions", PARENT_ID);
    mkdirSync(sessionsDir, { recursive: true });
    registerAgents(new Map());
    ctx = { cwd: root, sessionManager: { getSessionId: () => PARENT_ID } };
    manager = new AgentManager();
  });
  afterEach(async () => {
    await manager.dispose();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  /** Write a synthetic Pi session transcript ending with `assistant`. */
  function transcript(path: string, assistant: Record<string, unknown>): string {
    mkdirSync(join(path, ".."), { recursive: true });
    const lines = [
      { type: "session", version: 3, id: "child", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "do the thing", timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", stopReason: "stop", timestamp: 2, ...assistant } },
    ];
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    return path;
  }

  function tools(run: EvictedAgent) {
    manager.setEvictedIndex((id) => (id === run.id ? run : undefined));
    const details = createAgentResultBuilder(() => false);
    return createResultTools(pi, manager, {
      cancelNudge: vi.fn(),
      details: (record) => details({ displayName: record.type, description: record.description, subagentType: record.type }, record),
    }, { retrieve: vi.fn() });
  }

  function entry(sessionFile: string, overrides: Partial<EvictedAgent> = {}): EvictedAgent {
    return {
      id: "evicted-1",
      type: "general-purpose",
      description: "evicted review",
      status: "completed",
      startedAt: 1_000,
      completedAt: 4_000,
      toolUses: 3,
      lifetimeUsage: { input: 100, output: 20, cacheWrite: 30 },
      sessionFile,
      ...overrides,
    };
  }

  const finalAnswer = { content: [{ type: "text", text: "FINAL ANSWER" }] };

  it("S11 reports the indexed status, usage and last assistant text", async () => {
    const { getAgentResult } = tools(entry(transcript(join(sessionsDir, "child.jsonl"), finalAnswer)));

    const result = await getAgentResult.execute("get", { run_id: "evicted-1" }, undefined, undefined, ctx);

    expect(textOf(result)).toMatch(/^Agent: evicted-1\nType: .* \| Status: completed \| Tool uses: 3 \| 150 token \| Duration: 3\.0s\nDescription: evicted review\n\nFINAL ANSWER$/);
  });

  it("S11 details carry the transcript answer for the tool row", async () => {
    const { getAgentResult } = tools(entry(transcript(join(sessionsDir, "child.jsonl"), finalAnswer)));

    const result = await getAgentResult.execute("get", { run_id: "evicted-1" }, undefined, undefined, ctx);

    expect((result.details as { result?: string }).result).toBe("FINAL ANSWER");
  });

  it("S11 includes the final assistant error for an errored run", async () => {
    const file = transcript(join(sessionsDir, "child.jsonl"), { stopReason: "error", errorMessage: "provider exploded", content: [{ type: "text", text: "partial" }] });
    const { getAgentResult } = tools(entry(file, { status: "error" }));

    const result = await getAgentResult.execute("get", { run_id: "evicted-1" }, undefined, undefined, ctx);

    expect(textOf(result)).toMatch(/\n\nError: provider exploded\n\npartial$/);
  });

  it("S11 verbose appends the transcript conversation", async () => {
    const { getAgentResult } = tools(entry(transcript(join(sessionsDir, "child.jsonl"), finalAnswer)));

    const result = await getAgentResult.execute("get", { run_id: "evicted-1", verbose: true }, undefined, undefined, ctx);

    expect(textOf(result)).toMatch(/\n\n--- Agent Conversation ---\n\[User\]: do the thing\n\n\[Assistant\]: FINAL ANSWER$/);
  });

  it("S11 wait:true on an indexed run returns at once", async () => {
    const { getAgentResult } = tools(entry(transcript(join(sessionsDir, "child.jsonl"), finalAnswer)));

    const result = await getAgentResult.execute("get", { run_id: "evicted-1", wait: true }, undefined, undefined, ctx);

    expect(textOf(result)).toMatch(/FINAL ANSWER$/);
  });

  it("S11 a missing transcript reports Transcript unavailable", async () => {
    const { getAgentResult } = tools(entry(join(sessionsDir, "gone.jsonl")));

    const result = await getAgentResult.execute("get", { run_id: "evicted-1" }, undefined, undefined, ctx);

    expect(textOf(result)).toMatch(/\n\nTranscript unavailable \(session file is missing\)\.$/);
  });

  it("S11 a pointer outside containment is unavailable and never read", async () => {
    const outside = transcript(join(root, "elsewhere", "child.jsonl"), { content: [{ type: "text", text: "SECRET" }] });
    const { getAgentResult } = tools(entry(outside));

    const result = await getAgentResult.execute("get", { run_id: "evicted-1" }, undefined, undefined, ctx);

    expect(textOf(result)).toMatch(/\n\nTranscript unavailable \(session file is outside this session's subagent session directories\)\.$/);
  });

  it("S11 retrieval never inserts a live record", async () => {
    const { getAgentResult } = tools(entry(transcript(join(sessionsDir, "child.jsonl"), finalAnswer)));

    await getAgentResult.execute("get", { run_id: "evicted-1", verbose: true }, undefined, undefined, ctx);

    expect(manager.listAgents()).toEqual([]);
  });

  it("S12 steering an indexed run reports that it is not running and how to continue it", async () => {
    const { steer } = tools(entry(join(sessionsDir, "child.jsonl")));

    const result = await steer.execute("steer", { agent_id: "evicted-1", message: "change course" }, undefined, undefined, ctx);

    expect(textOf(result)).toBe('Agent "evicted-1" is not running (status: completed). Cannot steer a non-running agent.\nTo continue it, call agent with resume: "evicted-1" and a new prompt.');
  });
});
