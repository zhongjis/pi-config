import { fixtureAgent } from "./helpers/fixture-agent.js";
import { describe, expect, it } from "vitest";
import { buildAgentPrompt, SUBAGENT_COMMUNICATION_CONTRACT } from "../src/prompts.js";
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

describe("buildAgentPrompt", () => {
  it.each(["replace", "system_instructions"] as const)("injects the shared communication contract in %s mode with and without skills", (promptMode) => {
    const config: AgentConfig = {
      name: "fixture",
      description: "Fixture",
      extensionRules: [],
      toolRules: [],
      discoverSkills: true,
      preloadSkills: [],
      systemPrompt: "fixture instructions",
      promptMode,
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    for (const extras of [undefined, { skillBlocks: [{ name: "fixture-skill", content: "fixture skill content" }] }]) {
      const prompt = buildAgentPrompt(config, "/workspace", env, extras);
      expect(prompt.split(SUBAGENT_COMMUNICATION_CONTRACT)).toHaveLength(2);
      expect(prompt.indexOf(SUBAGENT_COMMUNICATION_CONTRACT)).toBeGreaterThan(prompt.indexOf(config.systemPrompt));
      if (extras) expect(prompt).toContain(extras.skillBlocks[0].content);
    }
  });

  it("includes cwd and git info", () => {
    const config = fixtureAgent;
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("omits branch transport for non-git repos", () => {
    const config = fixtureAgent;
    const prompt = buildAgentPrompt(config, "/workspace", envNoGit);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("linux");
    expect(prompt).not.toContain("Branch:");
  });

  it("replace mode uses config systemPrompt directly", () => {
    const config: AgentConfig = {
      name: "custom",
      description: "Custom",
      extensionRules: [],
      toolRules: [],
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

  it("injects preloaded skill blocks", () => {
    const config: AgentConfig = {
      name: "skill-agent",
      description: "Skill Agent",
      extensionRules: [],
      toolRules: [],
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
    const prompt = buildAgentPrompt(config, "/workspace", env, extras);
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
        extensionRules: [],
        toolRules: [],
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

    it("tag uses agent name verbatim", () => {
      const config: AgentConfig = {
        name: "Some Agent With Spaces",
        description: "Test",
        extensionRules: [],
        toolRules: [],
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
      for (const promptMode of ["replace", "system_instructions"] as const) {
        const config: AgentConfig = {
          name: "test-agent",
          description: "Test",
          extensionRules: [],
          toolRules: [],
          discoverSkills: true,
          preloadSkills: [],
          systemPrompt: "Test.",
          promptMode,
          inheritContext: false,
          runInBackground: false,
          isolated: false,
        };
        const prompt = buildAgentPrompt(config, "/workspace", env);
        const tagIndex = prompt.indexOf('<active_agent name="test-agent"/>');
        const cwdIndex = prompt.indexOf("/workspace");
        expect(tagIndex).toBeLessThan(cwdIndex);
      }
    });
  });
});
