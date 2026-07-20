import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAvailableTypes,
  getConfig,
  getToolNamesForType,
  isValidType,
  registerAgents,
  resolveType,
} from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    discoverSkills: false,
    preloadSkills: [],
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("agent type registry", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  describe("empty registry", () => {
    it("rejects unknown types", () => {
      expect(isValidType("nonexistent")).toBe(false);
      expect(isValidType("")).toBe(false);
    });

    it("getConfig throws for unknown types", () => {
      expect(() => getConfig("nonexistent")).toThrow("'nonexistent' not found");
    });

    it("BUILTIN_TOOL_NAMES includes all built-in tools", () => {
      expect(BUILTIN_TOOL_NAMES).toContain("read");
      expect(BUILTIN_TOOL_NAMES).toContain("bash");
      expect(BUILTIN_TOOL_NAMES).toContain("edit");
      expect(BUILTIN_TOOL_NAMES).toContain("write");
      expect(BUILTIN_TOOL_NAMES).toContain("grep");
      expect(BUILTIN_TOOL_NAMES).toContain("find");
      expect(BUILTIN_TOOL_NAMES).toContain("ls");
      expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe("user agents", () => {
    it("registers and retrieves user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor", description: "Auditor" })]]);
      registerAgents(agents);

      expect(isValidType("auditor")).toBe(true);
      expect(getAgentConfig("auditor")?.description).toBe("Auditor");
    });

    it("includes registered agents in available types", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);

      const types = getAvailableTypes();
      expect(types).toContain("auditor");
    });

    it("lists registered agent names", () => {
      const agents = new Map([
        ["auditor", makeAgentConfig({ name: "auditor" })],
        ["reviewer", makeAgentConfig({ name: "reviewer" })],
      ]);
      registerAgents(agents);

      const names = getAvailableTypes();
      expect(names).toEqual(["auditor", "reviewer"]);
    });

    it("case-insensitive lookup works for isValidType", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);
      expect(isValidType("AUDITOR")).toBe(true);
      expect(isValidType("Auditor")).toBe(true);
    });

    it("resolveType returns canonical key or undefined", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);
      expect(resolveType("auditor")).toBe("auditor");
      expect(resolveType("AUDITOR")).toBe("auditor");
      expect(resolveType("nonexistent")).toBeUndefined();
    });

    it("getConfig returns config for user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({
        name: "auditor",
        description: "Security auditor",
        builtinToolNames: ["read", "grep"],
        extensions: false,
        discoverSkills: true,
        preloadSkills: [],
      })]]);
      registerAgents(agents);

      const config = getConfig("auditor");
      expect(config.displayName).toBe("auditor");
      expect(config.description).toBe("Security auditor");
      expect(config.builtinToolNames).toEqual(["read", "grep"]);
      expect(config.extensions).toBe(false);
      expect(config.discoverSkills).toBe(true);
      expect(config.preloadSkills).toEqual([]);
    });

    it("getConfig returns extension source scope for user agents", () => {
      const agents = new Map([["partial", makeAgentConfig({
        name: "partial",
        extensions: ["web-search"],
        discoverSkills: false,
        preloadSkills: ["planning"],
      })]]);
      registerAgents(agents);

      const config = getConfig("partial");
      expect(config.extensions).toEqual(["web-search"]);
      expect(config.discoverSkills).toBe(false);
      expect(config.preloadSkills).toEqual(["planning"]);
    });

    it("getToolNamesForType works for user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({
        name: "auditor",
        builtinToolNames: ["read", "grep", "find"],
      })]]);
      registerAgents(agents);

      const names = getToolNamesForType("auditor");
      expect(names).toEqual(["read", "grep", "find"]);
    });

    it("getConfig throws for unknown types", () => {
      registerAgents(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));
      expect(() => getConfig("nonexistent")).toThrow("'nonexistent' not found");
    });

    it("clearing user agents works", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);
      expect(isValidType("auditor")).toBe(true);

      registerAgents(new Map());
      expect(isValidType("auditor")).toBe(false);
    });

    it("second registerAgents call replaces first", () => {
      const agents = new Map([["Explore", makeAgentConfig({
        name: "Explore",
        description: "Custom Explore",
        builtinToolNames: BUILTIN_TOOL_NAMES,
      })]]);
      registerAgents(agents);

      const config = getConfig("Explore");
      expect(config.description).toBe("Custom Explore");
      expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    });

    it("disabled agent is excluded from available types", () => {
      const agents = new Map([["Plan", makeAgentConfig({
        name: "Plan",
        enabled: false,
      })]]);
      registerAgents(agents);

      expect(isValidType("Plan")).toBe(false);
      expect(getAvailableTypes()).not.toContain("Plan");
    });

    it("getConfig throws for disabled agent", () => {
      const agents = new Map([["my-agent", makeAgentConfig({
        name: "my-agent",
        enabled: false,
      })]]);
      registerAgents(agents);

      expect(isValidType("my-agent")).toBe(false);
      expect(() => getConfig("my-agent")).toThrow();
    });

    // Regression guard — strategy fields must not be locked to false.
    it("user agents do not lock strategy fields (run_in_background / inherit_context / isolated)", () => {
      const cfg = makeAgentConfig({ name: "runner" });
      // makeAgentConfig sets these to false explicitly; real user agents loaded from .md files
      // will have them as undefined. Verify the registry doesn't force them.
      const agents = new Map([["runner", { ...cfg, runInBackground: undefined, inheritContext: undefined, isolated: undefined }]]);
      registerAgents(agents);

      const loaded = getAgentConfig("runner");
      expect(loaded?.runInBackground).toBeUndefined();
      expect(loaded?.inheritContext).toBeUndefined();
      expect(loaded?.isolated).toBeUndefined();
    });
  });
});
