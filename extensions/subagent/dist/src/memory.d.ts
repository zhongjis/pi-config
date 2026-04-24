/**
 * memory.ts — Persistent agent memory: per-agent memory directories that persist across sessions.
 *
 * Memory scopes:
 *   - "user"    → ~/.pi/agent-memory/{agent-name}/
 *   - "project" → .pi/agent-memory/{agent-name}/
 *   - "local"   → .pi/agent-memory-local/{agent-name}/
 */
import type { MemoryScope } from "./types.js";
/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export declare function isUnsafeName(name: string): boolean;
/**
 * Returns true if the given path is a symlink (defense against symlink attacks).
 */
export declare function isSymlink(filePath: string): boolean;
/**
 * Safely read a file, rejecting symlinks.
 * Returns undefined if the file doesn't exist, is a symlink, or can't be read.
 */
export declare function safeReadFile(filePath: string): string | undefined;
/**
 * Resolve the memory directory path for a given agent + scope + cwd.
 * Throws if agentName contains path traversal characters.
 */
export declare function resolveMemoryDir(agentName: string, scope: MemoryScope, cwd: string): string;
/**
 * Ensure the memory directory exists, creating it if needed.
 * Refuses to create directories if any component in the path is a symlink
 * to prevent symlink-based directory traversal attacks.
 */
export declare function ensureMemoryDir(memoryDir: string): void;
/**
 * Read the first N lines of MEMORY.md from the memory directory, if it exists.
 * Returns undefined if no MEMORY.md exists or if the path is a symlink.
 */
export declare function readMemoryIndex(memoryDir: string): string | undefined;
/**
 * Build the memory block to inject into the agent's system prompt.
 * Also ensures the memory directory exists (creates it if needed).
 */
export declare function buildMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string;
/**
 * Build a read-only memory block for agents that lack write/edit tools.
 * Does NOT create the memory directory — agents can only consume existing memory.
 */
export declare function buildReadOnlyMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string;
