/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentConfig } from "./types.js";
/** All known built-in tool names, derived from the factory registry. */
export declare const BUILTIN_TOOL_NAMES: string[];
/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export declare function registerAgents(userAgents: Map<string, AgentConfig>): void;
/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export declare function resolveType(name: string): string | undefined;
/** Get the agent config for a type (case-insensitive). */
export declare function getAgentConfig(name: string): AgentConfig | undefined;
/** Get all enabled type names (for spawning and tool descriptions). */
export declare function getAvailableTypes(): string[];
/** Get all type names including disabled (for UI listing). */
export declare function getAllTypes(): string[];
/** Get names of default agents currently in the registry. */
export declare function getDefaultAgentNames(): string[];
/** Get names of user-defined agents (non-defaults) currently in the registry. */
export declare function getUserAgentNames(): string[];
/** Check if a type is valid and enabled (case-insensitive). */
export declare function isValidType(type: string): boolean;
/**
 * Get the tools needed for memory management (read, write, edit).
 * Only returns tools that are NOT already in the provided set.
 */
export declare function getMemoryTools(cwd: string, existingToolNames: Set<string>): AgentTool<any>[];
/**
 * Get only the read tool for read-only memory access.
 * Only returns tools that are NOT already in the provided set.
 */
export declare function getReadOnlyMemoryTools(cwd: string, existingToolNames: Set<string>): AgentTool<any>[];
/** Get built-in tools for a type (case-insensitive). */
export declare function getToolsForType(type: string, cwd: string): AgentTool<any>[];
/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). Falls back to general-purpose. */
export declare function getConfig(type: string): {
    displayName: string;
    description: string;
    builtinToolNames: string[];
    extensions: true | string[] | false;
    skills: true | string[] | false;
    promptMode: "replace" | "append";
};
