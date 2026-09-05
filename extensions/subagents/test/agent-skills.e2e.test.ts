import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentCall, agentToolCalls, agentToolResults, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";

describe("skill delivery (faux print runtime)", () => {
  it.each([
    { background: false, discover: true, preload: "canonical", isolated: false, injected: 1, catalog: 1 },
    { background: true, discover: true, preload: "canonical", isolated: false, injected: 1, catalog: 1 },
    { background: false, discover: false, preload: "canonical", isolated: false, injected: 1, catalog: 0 },
    { background: false, discover: true, preload: "missing", isolated: false, injected: 0, catalog: 1 },
    { background: false, discover: true, preload: "canonical", isolated: true, injected: 0, catalog: 0 },
  ])("background=$background discover=$discover preload=$preload isolated=$isolated", async (scenario) => {
    const payloadCounts: number[] = [];
    const readPaths: string[] = [];
    let referencePath = "";
    const run = await runPrintMode({
      prompt: "Delegate the probe.",
      beforeRun: () => {
        // Bound ancestor catalog discovery to this disposable project.
        mkdirSync(join(process.cwd(), ".git"));
        const agentDir = join(process.cwd(), ".pi", "agents");
        const skillDir = join(process.cwd(), ".pi", "skills", "canonical");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(agentDir, "skill-probe.md"),
          `---\nname: skill-probe\nextensions: false\nbuiltin_tools: read\npersist_session: false\noutput_transcript: false\ndiscover_skills: ${scenario.discover}\npreload_skills: ${scenario.preload}\n---\nRun the probe.\n`);
        writeFileSync(join(skillDir, "SKILL.md"), "---\nname: canonical\ndescription: Runtime fixture\n---\nINJECTED_SKILL_79c2\n");
        referencePath = join(skillDir, "reference.txt");
        writeFileSync(referencePath, "RELATIVE_RESOURCE_79c2");
      },
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "skill-probe", description: "skill probe", prompt: "Run.",
          skills: [scenario.preload, scenario.preload],
          isolated: scenario.isolated, run_in_background: scenario.background,
        }),
        subagent: (context) => {
          const prompt = context.systemPrompt ?? "";
          payloadCounts.push(prompt.split("INJECTED_SKILL_79c2").length - 1);
          const readResult = context.messages.find((message) => message.role === "toolResult" && message.toolName === "read");
          if (readResult?.role === "toolResult") return readResult.content.filter((block) => block.type === "text").map((block) => block.text).join("");
          // Consume the injected provenance as a skill-relative read, not host cwd.
          const source = /^Source: (.+)$/m.exec(prompt)?.[1];
          const baseDir = /^Skill directory: (.+)$/m.exec(prompt)?.[1];
          if (!source || !baseDir) return "NO_SKILL_RESOURCE";
          const path = join(baseDir, "reference.txt");
          readPaths.push(path);
          return fauxToolCall("read", { path });
        },
      }),
    });
    try {
      expect(run.parentSession.resourceLoader.getExtensions().errors).toEqual([]);
      expect(agentToolCalls(run.parentSession)).toHaveLength(1);
      expect(payloadCounts.length).toBeGreaterThan(0);
      expect(new Set(payloadCounts), agentToolResults(run.parentSession).join("\n")).toEqual(new Set([scenario.injected]));
      expect(readPaths).toEqual(scenario.injected ? [referencePath] : []);
      const results = agentToolResults(run.parentSession).join("\n");
      const id = /Agent ID: (\S+)/.exec(results)?.[1] ?? /agent_id="([^"]+)"/.exec(results)?.[1];
      const child = id ? run.manager?.getRecord(id) : undefined;
      expect(child, results).toMatchObject({ status: "completed", result: scenario.injected ? "RELATIVE_RESOURCE_79c2" : "NO_SKILL_RESOURCE" });
      if (!child || typeof child !== "object" || !("session" in child)) throw new Error("No child record");
      const session = child.session;
      if (!session || typeof session !== "object" || !("resourceLoader" in session)) throw new Error("No child session");
      const loader = session.resourceLoader;
      if (!loader || typeof loader !== "object" || !("getSkills" in loader) || typeof loader.getSkills !== "function") throw new Error("No child resource loader");
      expect(loader.getSkills()).toMatchObject({
        diagnostics: [], skills: scenario.catalog ? [expect.objectContaining({ name: "canonical" })] : [],
      });
    } finally {
      await run.dispose();
    }
  });
});
