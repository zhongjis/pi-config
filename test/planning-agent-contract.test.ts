import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCustomAgentsWithDiagnostics } from "../extensions/subagents-new/src/custom-agents.js";

function readRepoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf-8");
}

function loadRepoAgents() {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = process.cwd();
  const result = loadCustomAgentsWithDiagnostics(process.cwd());
  return { result, previousAgentDir };
}

function restoreAgentDir(previousAgentDir: string | undefined): void {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

describe("planning agent contract", () => {
  let previousAgentDir: string | undefined;

  afterEach(() => {
    restoreAgentDir(previousAgentDir);
    previousAgentDir = undefined;
  });

  it("registers Xuannv as a callable tactical planner", () => {
    const loaded = loadRepoAgents();
    previousAgentDir = loaded.previousAgentDir;

    const xuannv = loaded.result.agents.get("xuannv");

    expect(xuannv, "Xuannv agent must be loadable from agents/xuannv.md").toBeDefined();
    expect(xuannv?.allowNesting).toBe(true);
    expect(xuannv?.builtinToolNames).toEqual(["read"]);
    expect(xuannv?.extensionToolNames).toEqual(
      expect.arrayContaining(["Agent", "get_subagent_result", "steer_subagent"]),
    );
    expect(xuannv?.extensionToolNames).not.toEqual(
      expect.arrayContaining(["bash", "edit", "write"]),
    );
    expect(xuannv?.allowDelegationTo).toEqual([
      "chengfeng",
      "wenchang",
      "direnjie",
    ]);
    expect(loaded.result.diagnostics.filter((diagnostic) => diagnostic.agentName === "xuannv")).toEqual([]);
  });

  it("keeps tactical planning separate from Fu Xi ceremony", () => {
    const loaded = loadRepoAgents();
    previousAgentDir = loaded.previousAgentDir;

    const prompt = loaded.result.agents.get("xuannv")?.systemPrompt ?? "";

    expect(prompt, "Xuannv prompt must return plan text to parent").toMatch(/return.+plan.+parent/i);
    expect(prompt).not.toContain("local://DRAFT.md");
    expect(prompt).not.toContain("local://PLAN.md");
    expect(prompt).not.toContain("plan_approve");
  });

  it("routes Kuafu and both ULW prompt families to Xuannv", () => {
    const kuafuMode = readRepoFile("modes/kuafu/mode.md");
    const ulwDefault = readRepoFile("extensions/ulw/prompts/default.md");
    const ulwGpt = readRepoFile("extensions/ulw/prompts/gpt.md");
    const ulwSource = readRepoFile("extensions/ulw/index.ts");

    expect(kuafuMode).toMatch(/allow_delegation_to: .*\bxuannv\b/);
    expect(ulwDefault).toContain('subagent_type="xuannv"');
    expect(ulwGpt).toContain('subagent_type="xuannv"');
    expect(`${ulwDefault}\n${ulwGpt}`).not.toContain('subagent_type="fuxi"');
    expect(ulwSource).toContain("chengfeng/wenchang/taishang/xuannv/jintong");
  });
});
