/**
 * agent-tool-evicted-resume.test.ts — `agent({ resume })` on an id that exists
 * only in the owning activation's agent-history index (the reload case),
 * through the real extension wiring.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { outputFilePath } from "../src/output-file.js";
import { artifactDirs, boot, dir, mockSessions, openSessionMock } from "./graph-run-registration.fixture.js";
import { fakeSession, opened, type Script } from "./helpers/session-seam.js";

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";
const historyPath = () => join(dir, "global", "local", "parent", "agent-history.json");

function childFile(path = join(dir, "global", "subagent-sessions", "parent", "child.jsonl")): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "synthetic\n");
  return path;
}

/** Persist a history index holding one evicted run, then start the owning activation. */
async function bootIndexed(sessionFile = childFile()) {
  mkdirSync(dirname(historyPath()), { recursive: true });
  writeFileSync(historyPath(), JSON.stringify({ version: 1, runs: [{
    id: "evicted-1", type: "fixture", description: "evicted review", status: "completed",
    startedAt: 1, completedAt: 2, toolUses: 3, lifetimeUsage: { input: 100, output: 20, cacheWrite: 30 }, sessionFile,
  }] }));
  const host = boot();
  await host.lifecycle("session_start");
  return host;
}

/** Record each opened session's reopen pointer; every session answers with `script`. */
function recordRuns(script?: Script): Array<string | undefined> {
  const runs: Array<string | undefined> = [];
  openSessionMock.mockImplementation(async (_ctx, _type, options) => {
    runs.push(options.resumeSessionFile);
    return opened(fakeSession(script));
  });
  return runs;
}

function resume(host: Awaited<ReturnType<typeof bootIndexed>>, id = "evicted-1", extra: Record<string, unknown> = {}) {
  return host.tools.get("agent")!.execute("call", {
    prompt: "again", description: "resume", subagent_type: "fixture", resume: id, ...extra,
  }, undefined, undefined, host.ctx);
}

describe("agent resume of an evicted, indexed run", () => {
  it("foreground resume reopens the indexed file and returns the restored run's result", async () => {
    const file = childFile();
    const host = await bootIndexed(file);
    const runs = recordRuns();

    const result = await resume(host);

    expect({ text: textOf(result), runs }).toEqual({ text: "again", runs: [realpathSync(file)] });
  });

  it("background resume returns the resumed message while the restored run is still executing", async () => {
    const host = await bootIndexed();
    let release = () => {};
    mockSessions(async (prompt) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return prompt;
    });

    try {
      const result = await resume(host, "evicted-1", { run_in_background: true });

      expect(textOf(result)).toMatch(/^Agent resumed in background\.\nAgent ID: evicted-1\n/);
    } finally { release(); }
  });

  it("background resume tracks the completion notification under the resuming tool call", async () => {
    const host = await bootIndexed();

    await resume(host, "evicted-1", { run_in_background: true });

    expect((await host.notification("evicted-1")).content).toContain("<tool-use-id>call</tool-use-id>");
  });

  it("a refused restore returns its reason as the tool text", async () => {
    const host = await bootIndexed(childFile(join(dir, "elsewhere", "child.jsonl")));

    const result = await resume(host);

    expect(textOf(result)).toBe(`Agent "evicted-1" cannot be resumed: session file is outside this session's subagent session directories.`);
  });

  it("an id that is neither live nor indexed is not found", async () => {
    const host = await bootIndexed();

    const result = await resume(host, "unknown-1");

    expect(textOf(result)).toBe('Agent not found: "unknown-1". It may have been cleaned up.');
  });

  it("a live resume still continues the live session", async () => {
    const host = await bootIndexed();
    const runs = recordRuns((prompt) => (prompt === "first" ? prompt : "LIVE"));
    const spawned = await host.tools.get("agent")!.execute("spawn", { prompt: "first", description: "live", subagent_type: "fixture" }, undefined, undefined, host.ctx);
    const id = (spawned.details as { agentId?: string } | undefined)?.agentId ?? "";

    const result = await resume(host, id);

    expect({ text: textOf(result), runs }).toEqual({ text: "LIVE", runs: [undefined] });
  });

  it("a restored run re-enters agent history with continued accounting", async () => {
    const file = childFile();
    const host = await bootIndexed(file);
    mockSessions((prompt) => ({ text: prompt, usage: { input: 10, output: 2, cacheWrite: 3 } }), { sessionFile: realpathSync(file) });

    await resume(host);

    await vi.waitFor(() => {
      const saved = JSON.parse(readFileSync(historyPath(), "utf8")) as { runs: unknown[] };
      expect(saved.runs[0]).toMatchObject({ id: "evicted-1", status: "completed", toolUses: 3, lifetimeUsage: { input: 110, output: 22, cacheWrite: 33 } });
    });
  });

  describe("transcript", () => {
    /** Restore with a session holding one prior message, then add one new message. */
    async function resumeWithTranscript(settings: Record<string, unknown>) {
      const host = boot(settings);
      await host.lifecycle("session_start");
      mkdirSync(dirname(historyPath()), { recursive: true });
      writeFileSync(historyPath(), JSON.stringify({ version: 1, runs: [{
        id: "evicted-1", type: "fixture", description: "evicted review", status: "completed",
        startedAt: 1, completedAt: 2, toolUses: 3, lifetimeUsage: { input: 1, output: 1, cacheWrite: 1 }, sessionFile: childFile(),
      }] }));
      await host.lifecycle("session_start");
      const path = outputFilePath(dir, "evicted-1", "parent");
      artifactDirs.add(dirname(dirname(dirname(path))));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "ORIGINAL\n");
      mockSessions((prompt, session) => {
        session.messages.push({ role: "user", content: prompt });
        session.reply({ text: "NEW" });
        session.turn();
        return undefined;
      }, { messages: [{ role: "user", content: "earlier" }] });
      const result = await resume(host);
      return { path, result };
    }

    it("a restored resume appends only its new messages after the existing transcript bytes", async () => {
      const { path } = await resumeWithTranscript({ outputTranscript: true });

      const text = readFileSync(path, "utf8");
      expect({ kept: text.startsWith("ORIGINAL\n"), earlier: text.includes("earlier"), appended: text.includes("NEW") }).toEqual({ kept: true, earlier: false, appended: true });
    });

    it("no transcript is written when the type's output_transcript is false", async () => {
      const { path } = await resumeWithTranscript({ outputTranscript: false });

      expect(readFileSync(path, "utf8")).toBe("ORIGINAL\n");
    });
  });
});
