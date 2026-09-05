import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import type * as AgentRunner from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";
import { perfSession } from "./helpers/perf-fixtures.js";

vi.mock("../src/agent-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentRunner>();
  return { ...actual, runAgent: vi.fn() };
});

const primary = { provider: "first", id: "opus", name: "Opus" };
const fallback = { provider: "second", id: "astra", name: "Astra" };
const parent = { provider: "parent", id: "gpt", name: "Parent" };
const chain = "first/opus:xhigh, second/astra:medium";

interface Scenario {
  readonly name: string;
  readonly frontmatter?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly available?: typeof primary[];
  readonly expectedModel?: typeof primary;
  readonly expectedThinking?: string;
  readonly requestedThinking?: string;
  readonly requestedModel?: string;
  readonly error?: boolean;
}

const scenarios: Scenario[] = [
  { name: "preserves ordered priority", frontmatter: `model: ${chain}`, expectedModel: primary, expectedThinking: "xhigh" },
  { name: "selects the next available candidate and its suffix", frontmatter: `model: ${chain}`, available: [fallback, parent], thinking: "high", expectedModel: fallback, expectedThinking: "medium", requestedThinking: "high" },
  { name: "frontmatter thinking outranks all suffixes", frontmatter: `model: ${chain}\nthinking: low`, model: "parent/gpt:max", thinking: "high", expectedModel: primary, expectedThinking: "low", requestedThinking: "high", requestedModel: "parent/gpt:max" },
  { name: "does not leak an unavailable candidate's suffix", frontmatter: "model: first/opus:xhigh, second/astra", available: [fallback, parent], expectedModel: fallback },
  { name: "uses caller thinking when the selected candidate has no suffix", frontmatter: "model: first/opus:xhigh, second/astra", available: [fallback, parent], thinking: "high", expectedModel: fallback, expectedThinking: "high" },
  { name: "uses caller model suffix after frontmatter gaps", frontmatter: "model: second/astra", model: "parent/gpt:max", expectedModel: fallback, expectedThinking: "max", requestedModel: "parent/gpt:max" },
  { name: "normalizes caller thinking before dispatch", model: "second/astra:xhigh", thinking: "none", expectedModel: fallback, expectedThinking: "off" },
  { name: "resolves explicit caller chains", model: chain, available: [fallback, parent], expectedModel: fallback, expectedThinking: "medium" },
  { name: "frontmatter suffix outranks caller suffix", frontmatter: `model: ${chain}`, model: "first/opus:low", expectedModel: primary, expectedThinking: "xhigh", requestedThinking: "low" },
  { name: "does not report equivalent caller model chains as overrides", frontmatter: "model: second/astra", model: "missing/absent, second/astra:low", expectedModel: fallback, expectedThinking: "low" },
  { name: "rejects exhausted frontmatter instead of inheriting", frontmatter: "model: missing/absent:xhigh, unavailable/other", model: "parent/gpt", error: true },
  { name: "rejects exhausted caller chain", model: "missing/absent, unavailable/other", error: true },
  { name: "rejects an explicit empty chain", model: " , ", error: true },
  { name: "inherits parent when no model was supplied", expectedModel: parent },
];

describe.each(["registered", "nested"] as const)("%s Agent model-chain dispatch", (surface) => {
  let restore: () => void;
  let boot: ReturnType<typeof makePi>;
  let manager: AgentManager;
  let tool: ToolDefinition;
  let context: ReturnType<typeof ctx>;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: perfSession(), aborted: false, steered: false });
  });

  afterEach(async () => {
    await boot?.lifecycle.get("session_shutdown")?.({}, context);
    await manager?.dispose();
    restore?.();
    vi.restoreAllMocks();
  });

  it.each(scenarios)("$name", async (scenario) => {
    const env = hermeticDir({
      settings: { outputTranscript: false },
      agentFiles: { worker: `---\nname: worker\ndescription: test worker\n${scenario.frontmatter ?? ""}\n---\nDo the task.` },
    });
    restore = env.restore;
    boot = makePi();
    const available = scenario.available ?? [fallback, primary, parent];
    context = ctx({
      model: parent,
      modelRegistry: {
        getAll: () => [primary, fallback, parent],
        getAvailable: () => available,
        find: (provider: string, id: string) => [primary, fallback, parent].find(m => m.provider === provider && m.id === id),
      },
    });
    if (surface === "registered") {
      subagentsExtension(boot.pi);
      tool = boot.tools.get("Agent");
    } else {
      manager = new AgentManager();
      const nested = createNestedSubagentTools({ manager, pi: boot.pi, parentAgentId: "parent-id", depth: 1, maxSubagentDepth: 2, allowedSubagents: "all", configCwd: env.dir });
      const agent = nested.find(t => t.name === "Agent");
      if (!agent) throw new Error("Missing nested Agent tool");
      tool = agent;
    }
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    const result = tool.execute("call", {
      prompt: "bounded task", description: "test dispatch", subagent_type: "worker",
      model: scenario.model, thinking: scenario.thinking, run_in_background: false,
    }, undefined, undefined, context);

    if (scenario.error) {
      await expect(result).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
      return;
    }
    await result;
    expect(spawn).toHaveBeenCalledTimes(1);
    const options = spawn.mock.calls[0]?.[4];
    expect(options?.model).toBe(scenario.expectedModel);
    expect(options?.thinkingLevel).toBe(scenario.expectedThinking);
    expect(options?.invocation?.thinking).toBe(scenario.expectedThinking);
    if (surface === "registered") {
      expect(options?.invocation?.requestedThinking).toBe(scenario.requestedThinking);
      expect(options?.invocation?.requestedModel).toBe(scenario.requestedModel);
    }
  });
});
