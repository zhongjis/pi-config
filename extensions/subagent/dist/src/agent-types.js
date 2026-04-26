/**
 * agent-types.ts — Unified custom agent type registry.
 *
 * Loads user-defined agents from .pi/agents/*.md. Disabled agents are kept but excluded from spawning.
 */
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, } from "@mariozechner/pi-coding-agent";
const TOOL_FACTORIES = {
    read: (cwd) => createReadTool(cwd),
    bash: (cwd) => createBashTool(cwd),
    edit: (cwd) => createEditTool(cwd),
    write: (cwd) => createWriteTool(cwd),
    grep: (cwd) => createGrepTool(cwd),
    find: (cwd) => createFindTool(cwd),
    ls: (cwd) => createLsTool(cwd),
};
/** Default built-in tool names for agents that do not configure `tools`. */
export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"];
/** Unified runtime registry of user-defined agents. */
const agents = new Map();
/**
 * Register user-defined agents into the unified registry.
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents) {
    agents.clear();
    for (const [name, config] of userAgents) {
        agents.set(name, config);
    }
}
/** Case-insensitive key resolution. */
function resolveKey(name) {
    if (agents.has(name))
        return name;
    const lower = name.toLowerCase();
    for (const key of agents.keys()) {
        if (key.toLowerCase() === lower)
            return key;
    }
    return undefined;
}
/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name) {
    return resolveKey(name);
}
/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name) {
    const key = resolveKey(name);
    return key ? agents.get(key) : undefined;
}
/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes() {
    return [...agents.entries()]
        .filter(([_, config]) => config.enabled !== false)
        .map(([name]) => name);
}
/** Get all type names including disabled (for UI listing). */
export function getAllTypes() {
    return [...agents.keys()];
}
/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type) {
    const key = resolveKey(type);
    if (!key)
        return false;
    return agents.get(key)?.enabled !== false;
}
/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];
/**
 * Get the tools needed for memory management (read, write, edit).
 * Only returns tools that are NOT already in the provided set.
 */
export function getMemoryTools(cwd, existingToolNames) {
    return MEMORY_TOOL_NAMES
        .filter(n => !existingToolNames.has(n) && n in TOOL_FACTORIES)
        .map(n => TOOL_FACTORIES[n](cwd));
}
/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"];
/**
 * Get only the read tool for read-only memory access.
 * Only returns tools that are NOT already in the provided set.
 */
export function getReadOnlyMemoryTools(cwd, existingToolNames) {
    return READONLY_MEMORY_TOOL_NAMES
        .filter(n => !existingToolNames.has(n) && n in TOOL_FACTORIES)
        .map(n => TOOL_FACTORIES[n](cwd));
}
/** Get built-in tools for a type (case-insensitive). */
export function getToolsForType(type, cwd) {
    const key = resolveKey(type);
    const raw = key ? agents.get(key) : undefined;
    const config = raw?.enabled !== false ? raw : undefined;
    if (!config)
        throw new Error(`Unknown or disabled agent type: ${type}`);
    const toolNames = config.builtinToolNames?.length ? config.builtinToolNames : BUILTIN_TOOL_NAMES;
    return toolNames.filter((n) => n in TOOL_FACTORIES).map((n) => TOOL_FACTORIES[n](cwd));
}
/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). */
export function getConfig(type) {
    const key = resolveKey(type);
    const config = key ? agents.get(key) : undefined;
    if (config && config.enabled !== false) {
        return {
            displayName: config.displayName ?? config.name,
            description: config.description,
            builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
            extensions: config.extensions,
            skills: config.skills,
            promptMode: config.promptMode,
        };
    }
    throw new Error(`Unknown or disabled agent type: ${type}`);
}
