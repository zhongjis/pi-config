/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type AgentSession, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SubagentType, ThinkingLevel } from "./types.js";
/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export declare function normalizeMaxTurns(n: number | undefined): number | undefined;
/** Get the default max turns value. undefined = unlimited. */
export declare function getDefaultMaxTurns(): number | undefined;
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export declare function setDefaultMaxTurns(n: number | undefined): void;
/** Get the grace turns value. */
export declare function getGraceTurns(): number;
/** Set the grace turns value (minimum 1). */
export declare function setGraceTurns(n: number): void;
/** Info about a tool event in the subagent. */
export interface ToolActivity {
    type: "start" | "end";
    toolName: string;
}
export interface RunOptions {
    /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
    pi: ExtensionAPI;
    model?: Model<any>;
    maxTurns?: number;
    signal?: AbortSignal;
    isolated?: boolean;
    inheritContext?: boolean;
    thinkingLevel?: ThinkingLevel;
    /** Override working directory (e.g. for worktree isolation). */
    cwd?: string;
    /** Called on tool start/end with activity info. */
    onToolActivity?: (activity: ToolActivity) => void;
    /** Called on streaming text deltas from the assistant response. */
    onTextDelta?: (delta: string, fullText: string) => void;
    onSessionCreated?: (session: AgentSession) => void;
    /** Called at the end of each agentic turn with the cumulative count. */
    onTurnEnd?: (turnCount: number) => void;
}
export interface RunResult {
    responseText: string;
    session: AgentSession;
    /** True if the agent was hard-aborted (max_turns + grace exceeded). */
    aborted: boolean;
    /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
    steered: boolean;
}
export declare function runAgent(ctx: ExtensionContext, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult>;
/**
 * Send a new prompt to an existing session (resume).
 */
export declare function resumeAgent(session: AgentSession, prompt: string, options?: {
    onToolActivity?: (activity: ToolActivity) => void;
    signal?: AbortSignal;
}): Promise<string>;
/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export declare function steerAgent(session: AgentSession, message: string): Promise<void>;
/**
 * Get the subagent's conversation messages as formatted text.
 */
export declare function getAgentConversation(session: AgentSession): string;
