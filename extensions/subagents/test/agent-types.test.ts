import { beforeEach, describe, expect, it } from "vitest";
import { type AccessRuleField, parseAccessRules } from "../../lib/active-tools.js";
import {
  getAgentConfig,
  getAvailableTypes,
  getConfig,
  isValidType,
  registerAgents,
} from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

const rules = (field: AccessRuleField, value: string) => parseAccessRules(field, value).rules;

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    extensionRules: [],
    toolRules: rules("tools", "+read, +grep"),
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

  describe("user agents", () => {
    it("registers and retrieves user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor", description: "Auditor" })]]);
      registerAgents(agents);

      expect(isValidType("auditor")).toBe(true);
      expect(getAgentConfig("auditor")?.description).toBe("Auditor");
    });

    it("includes user agents in available types", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);

      const types = getAvailableTypes();
      expect(types).toContain("auditor");
    });

    it("getConfig returns config for user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({
        name: "auditor",
        description: "Security auditor",
        extensionRules: [],
        toolRules: rules("tools", "+read, +grep"),
        discoverSkills: true,
        preloadSkills: [],
      })]]);
      registerAgents(agents);

      const config = getConfig("auditor");
      expect(config.displayName).toBe("auditor");
      expect(config.description).toBe("Security auditor");
      expect(config.toolRules).toEqual(rules("tools", "+read, +grep"));
      expect(config.extensionRules).toEqual([]);
      expect(config.discoverSkills).toBe(true);
    });

    it("getConfig returns extension rules for user agents", () => {
      const agents = new Map([["partial", makeAgentConfig({
        name: "partial",
        extensionRules: rules("extensions", "+web-search"),
        discoverSkills: true,
        preloadSkills: ["planning"],
      })]]);
      registerAgents(agents);

      const config = getConfig("partial");
      expect(config.extensionRules).toEqual(rules("extensions", "+web-search"));
      expect(config.preloadSkills).toEqual(["planning"]);
    });

    it("clearing user agents works", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);
      expect(isValidType("auditor")).toBe(true);

      registerAgents(new Map());
      expect(isValidType("auditor")).toBe(false);
    });

    it("disabled agent is excluded from available types", () => {
      const agents = new Map([["fixture", makeAgentConfig({
        name: "fixture",
        enabled: false,
      })]]);
      registerAgents(agents);

      expect(isValidType("fixture")).toBe(false);
      expect(getAvailableTypes()).not.toContain("fixture");
    });

  });
});
