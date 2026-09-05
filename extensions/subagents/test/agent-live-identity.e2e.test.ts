import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runPrintMode } from "./helpers/print-mode-runner.js";

function resultId(result: ToolResultMessage<unknown>): string {
  const details = result.details;
  if (details && typeof details === "object" && "agentId" in details && typeof details.agentId === "string") return details.agentId;
  const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const id = /^Agent(?: ID)?: (\S+)$/m.exec(text)?.[1];
  if (!id) throw new Error(`Missing canonical ID in ${result.toolName} result`);
  return id;
}

describe("live named identity (faux real SDK)", () => {
  it("retrieves and resumes the same named child and persistent conversation", async () => {
    const lookupAlias = "named-live";
    const childTurns: string[][] = [];
    let first: { id: string; record: object; session: unknown; file: string; sessionId: string } | undefined;
    const run = await runPrintMode({
      prompt: "Exercise the named child lifecycle.",
      beforeRun: () => {
        mkdirSync(join(process.cwd(), ".git"));
        const agents = join(process.cwd(), ".pi", "agents");
        mkdirSync(agents, { recursive: true });
        writeFileSync(join(agents, "identity-probe.md"),
          "---\nname: identity-probe\nextensions: false\nbuiltin_tools: none\ndiscover_skills: false\npersist_session: true\noutput_transcript: false\n---\nHandle the fixture request.\n");
      },
      respond: (context) => {
        if (!(context.tools ?? []).some((tool) => tool.name === "Agent")) {
          const prompts = context.messages.filter((message) => message.role === "user").map((message) =>
            typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
          );
          childTurns.push(prompts);
          return prompts.length === 1 ? "REPLY_FIRST" : "REPLY_SECOND";
        }
        const results = context.messages.filter((message) => message.role === "toolResult");
        if (results.length === 0) {
          return fauxToolCall("Agent", {
            subagent_type: "identity-probe", name: "named-live", description: "first identity turn",
            prompt: "REQUEST_FIRST", run_in_background: false,
          });
        }
        if (results.length === 1) {
          const id = resultId(results[0]);
          const manager: unknown = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
          if (!manager || typeof manager !== "object" || !("getRecord" in manager) || typeof manager.getRecord !== "function") throw new Error("No live manager");
          const record: unknown = manager.getRecord(id);
          if (!record || typeof record !== "object" || !("session" in record) || !("sessionFile" in record) || typeof record.sessionFile !== "string") throw new Error("No persistent child record");
          first = { id, record, session: record.session, file: record.sessionFile, sessionId: SessionManager.open(record.sessionFile).getSessionId() };
          return fauxToolCall("get_subagent_result", { agent_id: lookupAlias });
        }
        if (results.length === 2) {
          return fauxToolCall("Agent", {
            subagent_type: "identity-probe", resume: lookupAlias, description: "second identity turn",
            prompt: "REQUEST_SECOND", run_in_background: false,
          });
        }
        return "LIFECYCLE_DONE";
      },
    });
    try {
      expect(run.parentSession.resourceLoader.getExtensions().errors).toEqual([]);
      const results = run.parentSession.messages.filter((message) => message.role === "toolResult");
      expect(results.map((result) => result.toolName)).toEqual(["Agent", "get_subagent_result", "Agent"]);
      expect(results.map((result) => result.isError)).toEqual([false, false, false]);
      if (!first) throw new Error("Initial child was not captured");
      expect(results.map(resultId)).toEqual([first.id, first.id, first.id]);
      expect(childTurns).toEqual([["REQUEST_FIRST"], ["REQUEST_FIRST", "REQUEST_SECOND"]]);
      const child = run.manager?.getRecord(first.id);
      expect(child).toBe(first.record);
      expect(child).toMatchObject({ id: first.id, alias: "named-live", type: "identity-probe", status: "completed", result: "REPLY_SECOND", sessionFile: first.file });
      if (!child || typeof child !== "object" || !("session" in child)) throw new Error("Child session was lost");
      expect(child.session).toBe(first.session);
      expect(first.session).toBeDefined();
      expect(dirname(first.file)).toBe(join(getAgentDir(), "subagent-sessions", run.parentSession.sessionManager.getSessionId()));
      const saved = SessionManager.open(first.file);
      expect(saved.getSessionId()).toBe(first.sessionId);
      const conversation = saved.getBranch().flatMap((entry) => {
        if (entry.type !== "message") return [];
        const message = entry.message;
        if (message.role === "user" || message.role === "assistant") return [{
          role: message.role,
          text: typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
        }];
        return [];
      });
      expect(conversation).toEqual([
        { role: "user", text: "REQUEST_FIRST" }, { role: "assistant", text: "REPLY_FIRST" },
        { role: "user", text: "REQUEST_SECOND" }, { role: "assistant", text: "REPLY_SECOND" },
      ]);
      const manager = run.manager;
      if (manager && "listAgents" in manager && typeof manager.listAgents === "function") {
        expect(manager.listAgents()).toEqual([first.record]);
      }
    } finally {
      await run.dispose();
    }
  });
});
