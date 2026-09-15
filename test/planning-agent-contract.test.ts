import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadCustomAgentsWithDiagnostics } from "../extensions/subagents/src/custom-agents.js";
import { parseModeAgentConfig } from "../extensions/modes/src/config-loader.js";

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

describe("agent routing contract", () => {
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

  it.each([
    ["yunu", "visual-engineering"],
    ["guangguang", "quick"],
    ["jintong", "low-to-moderate"],
    ["juling", "substantial cross-module"],
  ])("exposes the %s routing boundary", (agentName, routingSignal) => {
    const loaded = loadRepoAgents();
    previousAgentDir = loaded.previousAgentDir;

    const agent = loaded.result.agents.get(agentName);

    expect(agent?.description.toLowerCase()).toContain(routingSignal);
  });

  it.each([
    [
      "yunu",
      "gemini-3.1-pro-preview:high,anthropic/claude-opus-4-8:xhigh,openai-codex/gpt-5.6-sol:medium,opencode-go/qwen3.6-plus:high,llama-swap/qwen2.5-coder:14b:high",
    ],
    [
      "guangguang",
      "claude-haiku-4-5,openai-codex/gpt-5.6-lua:fast:low,opencode-go/minimax-m2.5,llama-swap/qwen2.5-coder:7b:low",
    ],
    [
      "jintong",
      "claude-sonnet-4-6,openai-codex/gpt-5.6-terra:high,opencode-go/glm-5.2:high,llama-swap/qwen2.5-coder:14b:high",
    ],
    [
      "juling",
      "anthropic/claude-opus-4-8:xhigh,openai-codex/gpt-6-astra:medium,opencode-go/glm-5.2,llama-swap/qwen2.5-coder:14b:high",
    ],
  ])("preserves the %s model chain", (agentName, model) => {
    const loaded = loadRepoAgents();
    previousAgentDir = loaded.previousAgentDir;

    expect(loaded.result.agents.get(agentName)?.model).toBe(model);
  });

  it("registers Cangjie as the bounded writing specialist", () => {
    const loaded = loadRepoAgents();
    previousAgentDir = loaded.previousAgentDir;

    const cangjie = loaded.result.agents.get("cangjie");

    expect(cangjie, "Cangjie agent must be loadable from agents/cangjie.md").toBeDefined();
    expect(cangjie?.model).toBe("anthropic/claude-sonnet-4-6,openai-codex/gpt-5.6-sol:medium");
    expect(cangjie?.description.toLowerCase()).toContain("standalone human-facing");
    expect(cangjie?.builtinToolNames).toEqual(["read", "bash", "edit", "write"]);
    expect(cangjie?.extensionToolNames).toEqual(["codegraph_*", "lsp"]);
    expect(cangjie?.allowNesting).toBe(false);
    expect(cangjie?.preloadSkills).toEqual(["writing-clearly-and-concisely"]);
    expect(loaded.result.diagnostics.filter((diagnostic) => diagnostic.agentName === "cangjie")).toEqual([]);
  });

  it.each([
    ["kuafu", true],
    ["houtu", true],
    ["fuxi", false],
  ])("sets Cangjie delegation for %s", (mode, allowed) => {
    const config = parseModeAgentConfig(readFileSync(`modes/${mode}/mode.md`, "utf8"));

    expect(config?.allowDelegationTo?.includes("cangjie")).toBe(allowed);
  });

});
