/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type ToolActivity } from "./agent-runner.js";
import type { AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
interface SpawnOptions {
    description: string;
    model?: Model<any>;
    maxTurns?: number;
    signal?: AbortSignal;
    isolated?: boolean;
    inheritContext?: boolean;
    thinkingLevel?: ThinkingLevel;
    isBackground?: boolean;
    /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
    isolation?: IsolationMode;
    /** Resolved provider/model label for widget display. */
    modelLabel?: string;
    /** Called on tool start/end with activity info (for streaming progress to UI). */
    onToolActivity?: (activity: ToolActivity) => void;
    /** Called on streaming text deltas from the assistant response. */
    onTextDelta?: (delta: string, fullText: string) => void;
    /** Called when the agent session is created (for accessing session stats). */
    onSessionCreated?: (session: AgentSession) => void;
    /** Called at the end of each agentic turn with the cumulative count. */
    onTurnEnd?: (turnCount: number) => void;
}
export declare class AgentManager {
    private agents;
    private cleanupInterval;
    private onComplete?;
    private onStart?;
    private maxConcurrent;
    /** Queue of background agents waiting to start. */
    private queue;
    /** Number of currently running background agents. */
    private runningBackground;
    constructor(onComplete?: OnAgentComplete, maxConcurrent?: number, onStart?: OnAgentStart);
    /** Update the max concurrent background agents limit. */
    setMaxConcurrent(n: number): void;
    getMaxConcurrent(): number;
    /**
     * Spawn an agent and return its ID immediately (for background use).
     * If the concurrency limit is reached, the agent is queued.
     */
    spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string;
    /** Actually start an agent (called immediately or from queue drain). */
    private startAgent;
    /** Forward an outer tool abort signal into this agent's internal abort controller. */
    private bindExternalAbortSignal;
    /** Start queued agents up to the concurrency limit. */
    private drainQueue;
    /**
     * Spawn an agent and wait for completion (foreground use).
     * Foreground agents bypass the concurrency queue.
     */
    spawnAndWait(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: Omit<SpawnOptions, "isBackground">): Promise<AgentRecord>;
    /**
     * Resume an existing agent session with a new prompt.
     */
    resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord | undefined>;
    getRecord(id: string): AgentRecord | undefined;
    listAgents(): AgentRecord[];
    abort(id: string): boolean;
    /** Dispose a record's session and remove it from the map. */
    private removeRecord;
    private cleanup;
    /**
     * Remove all completed/stopped/errored records immediately.
     * Called on session start/switch so tasks from a prior session don't persist.
     */
    clearCompleted(): void;
    /** Whether any agents are still running or queued. */
    hasRunning(): boolean;
    /** Abort all running and queued agents immediately. */
    abortAll(): number;
    /** Wait for all running and queued agents to complete (including queued ones). */
    waitForAll(): Promise<void>;
    dispose(): void;
}
