import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { makePi } from "./helpers/boot-extension.js";
import { agentCall, agentToolResults, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";

describe("parent session storage (faux, real SessionManager)", () => {
  it("isolates persisted children by parent session", async () => {
    const parentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const run = await runPrintMode({
        prompt: "Delegate the greeting.",
        beforeRun: () => {
          mkdirSync(join(process.cwd(), ".pi", "agents"), { recursive: true });
          writeFileSync(join(process.cwd(), ".pi", "agents", "storage-probe.md"),
            "---\nname: storage-probe\noutput_transcript: false\n---\nReply briefly.\n");
        },
        respond: routeBySession({
          parentInitial: agentCall({
            subagent_type: "storage-probe", description: "storage probe", prompt: "Greet.", run_in_background: false,
          }),
          subagent: "CHILD_STORED",
        }),
      });
      try {
        expect(run.parentSession.resourceLoader.getExtensions().errors).toEqual([]);
        const results = agentToolResults(run.parentSession);
        expect(results).toHaveLength(1);
        const id = /Agent ID: (\S+)/.exec(results[0])?.[1];
        if (!id) throw new Error(`No child ID in Agent result: ${results[0]}`);
        const child = run.manager?.getRecord(id);
        expect(child).toMatchObject({ status: "completed", result: "CHILD_STORED" });
        if (!child || typeof child !== "object" || !("sessionFile" in child)) throw new Error("No child session file");
        const file = child.sessionFile;
        expect(typeof file).toBe("string");
        if (typeof file !== "string") throw new Error("Child did not persist a session");
        const parentId = run.parentSession.sessionManager.getSessionId();
        parentIds.push(parentId);
        expect(dirname(file)).toBe(join(getAgentDir(), "subagent-sessions", parentId));
        expect(readFileSync(file, "utf8")).toContain("CHILD_STORED");

        const cwd = process.cwd();
        const normal = SessionManager.create(cwd);
        normal.appendMessage({ role: "user", content: "normal session", timestamp: Date.now() });
        normal.appendMessage(fauxAssistantMessage([fauxText("NORMAL_STORED")]));
        const local = await SessionManager.list(cwd);
        const all = await SessionManager.listAll();
        for (const sessions of [local, all]) {
          expect(sessions.map((session) => session.id)).toContain(normal.getSessionId());
          expect(sessions.map((session) => session.path)).not.toContain(file);
        }
      } finally {
        await run.dispose();
      }
    }
    expect(new Set(parentIds).size).toBe(2);
  });

  it("preserves explicit session directory", async () => {
    const run = await runPrintMode({
      prompt: "Delegate the greeting.",
      beforeRun: () => {
        mkdirSync(join(process.cwd(), ".pi", "agents"), { recursive: true });
        writeFileSync(join(process.cwd(), ".pi", "agents", "storage-override.md"),
          "---\nname: storage-override\noutput_transcript: false\nsession_dir: ./custom-sessions\n---\nReply briefly.\n");
      },
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "storage-override", description: "override probe", prompt: "Greet.", run_in_background: false,
        }),
        subagent: "OVERRIDE_STORED",
      }),
    });
    try {
      expect(agentToolResults(run.parentSession).join("\n")).toContain("OVERRIDE_STORED");
      const directory = join(process.cwd(), "custom-sessions");
      const sessions = await SessionManager.list(process.cwd(), directory);
      expect(sessions).toHaveLength(1);
      expect(dirname(sessions[0].path)).toBe(directory);
      expect(readFileSync(sessions[0].path, "utf8")).toContain("OVERRIDE_STORED");
    } finally {
      await run.dispose();
    }
  });

  it("resumes existing session without relocating history", async () => {
    const run = await runPrintMode({
      prompt: "Prepare the host.",
      respond: routeBySession({ parentInitial: "Ready.", subagent: "CHILD_RESUMED" }),
    });
    const manager = new AgentManager();
    try {
      const saved = SessionManager.create(process.cwd());
      saved.appendMessage({ role: "user", content: "Earlier request", timestamp: Date.now() });
      saved.appendMessage(fauxAssistantMessage([fauxText("EARLIER_REPLY")]));
      const file = saved.getSessionFile();
      if (!file) throw new Error("Fixture did not persist a session");
      const original = readFileSync(file, "utf8");

      // Saved-file reopen is internal-only: the public Agent resume accepts live IDs, not file paths.
      const { record } = await manager.spawnAndWait(
        makePi().pi, run.parentSession.extensionRunner.createContext(), "general-purpose", "Continue.",
        { description: "resume probe", isolated: true, resumeSessionFile: file },
      );

      expect(record).toMatchObject({ status: "completed", result: "CHILD_RESUMED", sessionFile: file });
      const resumed = readFileSync(file, "utf8");
      expect(resumed.startsWith(original)).toBe(true);
      expect(resumed).toContain("CHILD_RESUMED");
      expect(record.session?.sessionManager.getSessionId()).toBe(saved.getSessionId());
    } finally {
      await manager.dispose();
      await run.dispose();
    }
  });
});
