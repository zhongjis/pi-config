/**
 * agent-types.ts — Unified agent type registry.
 *
 * Registers flat and directory agent definitions from project, workspace, and global locations.
 * Disabled agents are kept but excluded from spawning.
 */

import type { AccessRule } from "../../lib/active-tools.js";
import type { AgentConfig } from "./types.js";

/** Unified runtime registry of all agents (user-defined). */
const agents = new Map<string, AgentConfig>();

/**
 * Register agents into the unified registry.
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();

  for (const [name, config] of userAgents) {
    agents.set(name, config);
  }
}

/** Case-insensitive key resolution. */
function resolveKey(name: string): string | undefined {
  if (agents.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of agents.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveKey(name);
  return key ? agents.get(key) : undefined;
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
  const key = resolveKey(type);
  if (!key) return false;
  return agents.get(key)?.enabled !== false;
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). Throws for unknown or disabled types. */
export function getConfig(type: string): {
  displayName: string;
  description: string;
  extensionRules: AccessRule[];
  toolRules: AccessRule[];
  discoverSkills: boolean;
  preloadSkills: string[];
  promptMode: "replace" | "system_instructions";
} {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;
  if (config && config.enabled !== false) {
    return {
      displayName: config.displayName ?? config.name,
      description: config.description,
      extensionRules: config.extensionRules,
      toolRules: config.toolRules,
      discoverSkills: config.discoverSkills,
      preloadSkills: config.preloadSkills,
      promptMode: config.promptMode,
    };
  }

  throw new Error(`Unknown or disabled agent type "${type}"`);
}
