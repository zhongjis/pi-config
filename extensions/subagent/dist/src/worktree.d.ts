/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */
export interface WorktreeInfo {
    /** Absolute path to the worktree directory. */
    path: string;
    /** Branch name created for this worktree (if changes exist). */
    branch: string;
}
export interface WorktreeCleanupResult {
    /** Whether changes were found in the worktree. */
    hasChanges: boolean;
    /** Branch name if changes were committed. */
    branch?: string;
    /** Worktree path if it was kept. */
    path?: string;
}
/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export declare function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined;
/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export declare function cleanupWorktree(cwd: string, worktree: WorktreeInfo, agentDescription: string): WorktreeCleanupResult;
/**
 * Prune any orphaned worktrees (crash recovery).
 */
export declare function pruneWorktrees(cwd: string): void;
