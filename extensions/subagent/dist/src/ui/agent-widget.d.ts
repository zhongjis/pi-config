/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */
import type { AgentManager } from "../agent-manager.js";
import type { SubagentType } from "../types.js";
/** Braille spinner frames for animated running indicator. */
export declare const SPINNER: string[];
/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export declare const ERROR_STATUSES: Set<string>;
export type Theme = {
    fg(color: string, text: string): string;
    bold(text: string): string;
};
export type UICtx = {
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, content: undefined | ((tui: any, theme: Theme) => {
        render(): string[];
        invalidate(): void;
    }), options?: {
        placement?: "aboveEditor" | "belowEditor";
    }): void;
};
/** Per-agent live activity state. */
export interface AgentActivity {
    activeTools: Map<string, string>;
    toolUses: number;
    tokens: string;
    responseText: string;
    session?: {
        getSessionStats(): {
            tokens: {
                total: number;
            };
        };
    };
    /** Current turn count. */
    turnCount: number;
    /** Effective max turns for this agent (undefined = unlimited). */
    maxTurns?: number;
    /** Timestamp of the last observed progress signal for stale-agent supervision. */
    lastProgressAt: number;
}
/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
    displayName: string;
    description: string;
    subagentType: string;
    toolUses: number;
    tokens: string;
    durationMs: number;
    status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
    /** Human-readable description of what the agent is currently doing. */
    activity?: string;
    /** Current spinner frame index (for animated running indicator). */
    spinnerFrame?: number;
    /** Short model name if different from parent (e.g. "haiku", "sonnet"). */
    modelName?: string;
    /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
    tags?: string[];
    /** Current turn count. */
    turnCount?: number;
    /** Effective max turns (undefined = unlimited). */
    maxTurns?: number;
    agentId?: string;
    error?: string;
}
/** Format a token count compactly: "󰾆 33.8k", "󰾆 1.2M". */
export declare function formatTokens(count: number): string;
/** Format turn count with optional max limit: "⟳ 5≤30" or "⟳ 5". */
export declare function formatTurns(turnCount: number, maxTurns?: number | null): string;
/** Format milliseconds as human-readable duration. */
export declare function formatMs(ms: number): string;
/** Format duration from start/completed timestamps. */
export declare function formatDuration(startedAt: number, completedAt?: number): string;
/** Get display name for any agent type (built-in or custom). */
export declare function getDisplayName(type: SubagentType): string;
/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export declare function getPromptModeLabel(type: SubagentType): string | undefined;
/** Build a human-readable activity string from currently-running tools or response text. */
export declare function describeActivity(activeTools: Map<string, string>, responseText?: string): string;
export declare class AgentWidget {
    private manager;
    private agentActivity;
    private uiCtx;
    private widgetFrame;
    private widgetInterval;
    /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
    private finishedTurnAge;
    /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
    private static readonly ERROR_LINGER_TURNS;
    /** Whether the widget callback is currently registered with the TUI. */
    private widgetRegistered;
    /** Cached TUI reference from widget factory callback, used for requestRender(). */
    private tui;
    /** Last status bar text, used to avoid redundant setStatus calls. */
    private lastStatusText;
    constructor(manager: AgentManager, agentActivity: Map<string, AgentActivity>);
    /** Set the UI context (grabbed from first tool execution). */
    setUICtx(ctx: UICtx): void;
    /**
     * Called on each new turn (tool_execution_start).
     * Ages finished agents and clears those that have lingered long enough.
     */
    onTurnStart(): void;
    /** Ensure the widget update timer is running. */
    ensureTimer(): void;
    /** Check if a finished agent should still be shown in the widget. */
    private shouldShowFinished;
    /** Record an agent as finished (call when agent completes). */
    markFinished(agentId: string): void;
    /** Render a finished agent line. */
    private renderFinishedLine;
    /** Render a queued agent line. */
    private renderQueuedLine;
    /**
     * Render the widget content. Called from the registered widget's render() callback,
     * reading live state each time instead of capturing it in a closure.
     */
    private renderWidget;
    /** Force an immediate widget update. */
    update(): void;
    dispose(): void;
}
