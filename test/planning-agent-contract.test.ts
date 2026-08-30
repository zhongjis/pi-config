import { afterEach, describe, expect, it } from "vitest";
import { loadCustomAgentsWithDiagnostics } from "../extensions/subagents/src/custom-agents.js";

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
    expect(xuannv?.builtinToolNames).toEqual(["read", "bash"]);
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

});
