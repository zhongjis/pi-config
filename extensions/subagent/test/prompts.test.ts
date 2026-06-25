import { describe, expect, it } from "vitest";
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


describe("buildAgentPrompt", () => {
  it("includes cwd and git info", () => {
    const config: AgentConfig = {
      name: "test-agent", description: "Test", extensions: true, skills: true,
      systemPrompt: "", promptMode: "append",
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("handles non-git repos", () => {
    const config: AgentConfig = {
      name: "test-agent", description: "Test", extensions: true, skills: true,
      systemPrompt: "You are a test.", promptMode: "replace",
    };
    const prompt = buildAgentPrompt(config, "/workspace", envNoGit);
    expect(prompt).toContain("Not a git repository");
    expect(prompt).not.toContain("Branch:");
  });

  it("append mode with parent prompt is a twin", () => {
    const config: AgentConfig = {
      name: "test-agent", description: "Test", extensions: true, skills: true,
      systemPrompt: "", promptMode: "append",
    };
    const parentPrompt = "You are a parent coding agent with full powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("parent coding agent with full powers");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("READ-ONLY");
    // Empty systemPrompt means no <agent_instructions> section
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("append mode without parent prompt falls back to generic base", () => {
    const config: AgentConfig = {
      name: "test-agent", description: "Test", extensions: true, skills: true,
      systemPrompt: "", promptMode: "append",
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("coding agent for complex, multi-step tasks");
    expect(prompt).not.toContain("READ-ONLY");
  });

  it("append mode with parent prompt includes parent + custom instructions", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const parentPrompt = "You are a parent coding agent with special powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("parent coding agent with special powers");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode without parent prompt falls back to generic base", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("coding agent for complex, multi-step tasks");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode with empty systemPrompt is a pure parent clone", () => {
    const config: AgentConfig = {
      name: "clone",
      description: "Clone",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const parentPrompt = "You are a parent coding agent.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("parent coding agent");
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
      skills: true,
      systemPrompt: "You are a specialized agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("You are a specialized agent.");
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("You are a pi coding agent sub-agent");
  });

  it("replace mode ignores parent prompt", () => {
    const config: AgentConfig = {
      name: "standalone",
      description: "Standalone",
      builtinToolNames: [],
      extensions: true,
      skills: true,
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

  it("append mode bridge contains tool reminders", () => {
    const config = {
      name: "test-agent", description: "Test", extensions: true as const, skills: true as const,
      systemPrompt: "", promptMode: "append" as const,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt.");
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("Use the edit tool instead of sed");
    expect(prompt).toContain("Use the bash tool with rg for content search");
  });

  it("append mode without parent prompt still has bridge", () => {
    const config: AgentConfig = {
      name: "no-parent",
      description: "No parent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra stuff.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("coding agent for complex, multi-step tasks");
    expect(prompt).toContain("Extra stuff.");
  });

  it("append mode: parent content appears before sub_agent_context", () => {
    const config: AgentConfig = {
      name: "order-test",
      description: "Order test",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const parentPrompt = "UNIQUE_PARENT_CONTENT_MARKER";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    const parentIdx = prompt.indexOf("UNIQUE_PARENT_CONTENT_MARKER");
    const bridgeIdx = prompt.indexOf("<sub_agent_context>");
    expect(parentIdx).toBeGreaterThan(-1);
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(parentIdx).toBeLessThan(bridgeIdx);
  });

  it("injects preloaded skill blocks", () => {
    const config: AgentConfig = {
      name: "skill-agent",
      description: "Skill Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
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
    expect(prompt).toContain("Preloaded Skill: api-conventions");
    expect(prompt).toContain("Use REST endpoints.");
    expect(prompt).toContain("Preloaded Skill: error-handling");
    expect(prompt).toContain("Handle errors gracefully.");
  });


  it("no extras means no extra sections", () => {
    const config: AgentConfig = {
      name: "plain",
      description: "Plain",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Plain agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).not.toContain("Agent Memory");
    expect(prompt).not.toContain("Preloaded Skill");
  });
});
