/**
 * agent-types.ts — Unified custom agent type registry.
 *
 * Loads user-defined agents from .pi/agents/*.md. Disabled agents are kept but excluded from spawning.
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentConfig } from "./types.js";
/** Default built-in tool names for agents that do not configure `tools`. */
export declare const BUILTIN_TOOL_NAMES: string[];
/**
 * Register user-defined agents into the unified registry.
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
/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). */
export declare function getConfig(type: string): {
    displayName: string;
    description: string;
    builtinToolNames: string[];
    extensions: true | string[] | false;
    skills: true | string[] | false;
    promptMode: "replace" | "append";
};
