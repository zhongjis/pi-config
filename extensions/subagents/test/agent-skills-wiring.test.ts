import { describe, expect, it, vi } from "vitest";
import * as runner from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";
import { perfSession } from "./helpers/perf-fixtures.js";

vi.mock("../src/agent-runner.js", async (importOriginal) => ({
  ...await importOriginal<typeof runner>(),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

describe("Agent skill delivery", () => {
  it.each([false, true])("forwards per-call skills through registered Agent (background=%s)", async (background) => {
    const fixture = hermeticDir({ settings: { outputTranscript: false, rememberAgents: false } });
    const host = makePi();
    const context = ctx();
    try {
      subagentsExtension(host.pi);
      vi.mocked(runner.runAgent).mockReset();
      vi.mocked(runner.runAgent).mockResolvedValue({
        responseText: "SKILL_WIRING_DONE", session: perfSession(), aborted: false, steered: false,
      });
      const tool = host.tools.get("Agent");
      expect(tool.parameters.properties.skills).toMatchObject({ type: "array", items: { type: "string" } });
      expect(tool.parameters.required).not.toContain("skills");
      await tool.execute("skills-call", {
        subagent_type: "general-purpose", description: "skill delivery", prompt: "Run.",
        skills: ["configured", "per-call", "configured"], run_in_background: background,
      }, undefined, undefined, context);
      expect(runner.runAgent).toHaveBeenCalledExactlyOnceWith(
        context, "general-purpose", "Run.",
        expect.objectContaining({ skills: ["configured", "per-call", "configured"] }),
      );
    } finally {
      await host.lifecycle.get("session_shutdown")?.({}, context);
      fixture.restore();
    }
  });

  it("ignores per-call skills on retained-session resume", async () => {
    const fixture = hermeticDir({ settings: { outputTranscript: false, rememberAgents: false } });
    const host = makePi();
    const context = ctx();
    try {
      subagentsExtension(host.pi);
      vi.mocked(runner.runAgent).mockReset();
      const session = perfSession();
      vi.mocked(runner.runAgent).mockResolvedValue({ responseText: "DONE", session, aborted: false, steered: false });
      vi.mocked(runner.resumeAgent).mockReset();
      vi.mocked(runner.resumeAgent).mockResolvedValue({ text: "RESUMED" });
      const tool = host.tools.get("Agent");
      const result = await tool.execute("first", {
        subagent_type: "general-purpose", description: "first", prompt: "Run.", run_in_background: false,
      }, undefined, undefined, context);
      await tool.execute("resume", {
        subagent_type: "general-purpose", description: "resume", prompt: "Continue.",
        resume: result.details.agentId, skills: ["ignored"], run_in_background: false,
      }, undefined, undefined, context);
      expect(runner.runAgent).toHaveBeenCalledTimes(1);
      expect(runner.resumeAgent).toHaveBeenCalledExactlyOnceWith(session, "Continue.", expect.any(Object));
      expect(vi.mocked(runner.resumeAgent).mock.calls[0]?.[2]).not.toHaveProperty("skills");
    } finally {
      await host.lifecycle.get("session_shutdown")?.({}, context);
      fixture.restore();
    }
  });
});
