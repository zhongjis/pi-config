import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../../src/types.js";

export const fixtureAgent: AgentConfig = {
  name: "fixture",
  displayName: "Agent",
  description: "Test agent",
  extensionRules: [],
  toolRules: [],
  discoverSkills: false,
  preloadSkills: [],
  systemPrompt: "Fixture instructions",
  promptMode: "replace",
};

export function writeFixtureAgent(cwd: string): void {
  const directory = join(cwd, ".pi", "agents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "fixture.md"), "---\nname: fixture\ndescription: Test agent\n---\nFixture instructions\n");
}
