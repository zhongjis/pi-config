import type { AgentConfig } from "./types.js";
/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project: <cwd>/.pi/agents/*.md
 *   2. Global:  ~/.pi/agent/agents/*.md
 *
 * Project-level agents override global ones with the same name.
 */
export declare function loadCustomAgents(cwd: string): Map<string, AgentConfig>;
