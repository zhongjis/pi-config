import { beforeEach, describe, expect, it } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { buildAgentPrompt } from "../src/prompts.js";
import type { AgentConfig, EnvInfo } from "../src/types.js";

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  platform: "darwin",
};

const envNoGit: EnvInfo = {
  isGitRepo: false,
  branch: "",
  platform: "linux",
};

// Initialize default agents
beforeEach(() => {
  registerAgents(new Map());
});

function getDefaultConfig(name: string): AgentConfig {
  return getAgentConfig(name)!;
}

describe("buildAgentPrompt", () => {
  it("includes cwd and git info", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("omits branch transport for non-git repos", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", envNoGit);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("linux");
    expect(prompt).not.toContain("Branch:");
  });

  it("general-purpose uses append mode (parent twin)", () => {
    const config = getDefaultConfig("general-purpose");
    const parentPrompt = "You are a parent coding agent with full powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt.startsWith(parentPrompt)).toBe(true);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("general-purpose without parent prompt keeps protocol and environment transport", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain('<active_agent name="general-purpose"/>');
  });

  it("append mode with parent prompt includes parent + custom instructions", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      discoverSkills: true,
      preloadSkills: [],
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const parentPrompt = "You are a parent coding agent with special powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt.startsWith(parentPrompt)).toBe(true);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode without parent prompt transports custom instructions", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      discoverSkills: true,
      preloadSkills: [],
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode with empty systemPrompt is a pure parent clone", () => {
    const config: AgentConfig = {
      name: "clone",
      description: "Clone",
      builtinToolNames: [],
      extensions: true,
      discoverSkills: true,
      preloadSkills: [],
      systemPrompt: "",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const parentPrompt = "You are a parent coding agent.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt.startsWith(parentPrompt)).toBe(true);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("replace mode uses config systemPrompt directly", () => {
    const config: AgentConfig = {
      name: "custom",
      description: "Custom",
      builtinToolNames: [],
      extensions: true,
      discoverSkills: true,
      preloadSkills: [],
      systemPrompt: "You are a specialized agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("You are a specialized agent.");
    expect(prompt).toContain("/workspace");
  });

  it("replace mode ignores parent prompt", () => {
    const config: AgentConfig = {
      name: "standalone",
      description: "Standalone",
      builtinToolNames: [],
      extensions: true,
      discoverSkills: true,
      preloadSkills: [],
      systemPrompt: "You are a standalone agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, "SECRET parent prompt content");
    expect(prompt).toContain("You are a standalone agent.");
    expect(prompt).not.toContain("SECRET parent prompt content");
    expect(prompt).not.toContain("<sub_agent_context>");
  });


  it("append mode without parent prompt still has bridge", () => {
    const config: AgentConfig = {
      name: "no-parent",
      description: "No parent",
      builtinToolNames: [],
      extensions: true,
      discoverSkills: true,
      preloadSkills: [],
      systemPrompt: "Extra stuff.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain("Extra stuff.");
  });

  it("injects preloaded skill blocks", () => {
    const config: AgentConfig = {
      name: "skill-agent",
      description: "Skill Agent",
      builtinToolNames: [],
      extensions: true,
      discoverSkills: true,
      preloadSkills: [],
      systemPrompt: "You are a skill agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = {
      skillBlocks: [
        { name: "api-conventions", content: "Use REST endpoints." },
        { name: "error-handling", content: "Handle errors gracefully." },
      ],
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("api-conventions");
    expect(prompt).toContain("Use REST endpoints.");
    expect(prompt).toContain("error-handling");
    expect(prompt).toContain("Handle errors gracefully.");
  });


  describe("active_agent tag", () => {
    it("tag is present at start of prompt in replace mode", () => {
      const config: AgentConfig = {
        name: "my-agent",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        discoverSkills: true,
        preloadSkills: [],
        systemPrompt: "You are a test agent.",
        promptMode: "replace",
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env);
      expect(prompt).toMatch(/^<active_agent name="my-agent"\/>/);
    });

    it("tag follows the cacheable inherited prefix in append mode", () => {
      const config: AgentConfig = {
        name: "my-agent",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        discoverSkills: true,
        preloadSkills: [],
        systemPrompt: "Custom instructions.",
        promptMode: "append",
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt.");
      // Parent prompt must form the verbatim, cacheable byte prefix.
      expect(prompt.startsWith("Parent prompt.")).toBe(true);
      // The varying tag follows the static <sub_agent_context> bridge.
      const ctxIdx = prompt.indexOf("<sub_agent_context>");
      const tagIdx = prompt.indexOf('<active_agent name="my-agent"/>');
      expect(ctxIdx).toBeGreaterThan(-1);
      expect(tagIdx).toBeGreaterThan(ctxIdx);
    });

    it("tag uses agent name verbatim", () => {
      const config: AgentConfig = {
        name: "Some Agent With Spaces",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        discoverSkills: true,
        preloadSkills: [],
        systemPrompt: "Test.",
        promptMode: "replace",
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env);
      expect(prompt).toContain('<active_agent name="Some Agent With Spaces"/>');
    });

    it("tag appears before the env block in both modes", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const config: AgentConfig = {
          name: "test-agent",
          description: "Test",
          builtinToolNames: [],
          extensions: true,
          discoverSkills: true,
          preloadSkills: [],
          systemPrompt: "Test.",
          promptMode,
          inheritContext: false,
          runInBackground: false,
          isolated: false,
        };
        const prompt = buildAgentPrompt(config, "/workspace", env, "Parent.");
        const tagIndex = prompt.indexOf('<active_agent name="test-agent"/>');
        const cwdIndex = prompt.indexOf("/workspace");
        expect(tagIndex).toBeLessThan(cwdIndex);
      }
    });
  });
});
