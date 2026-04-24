/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { type Component, type TUI } from "@mariozechner/pi-tui";
import type { AgentRecord } from "../types.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity } from "./agent-widget.js";
export declare class ConversationViewer implements Component {
    private tui;
    private session;
    private record;
    private activity;
    private theme;
    private done;
    private scrollOffset;
    private autoScroll;
    private unsubscribe;
    private lastInnerW;
    private closed;
    constructor(tui: TUI, session: AgentSession, record: AgentRecord, activity: AgentActivity | undefined, theme: Theme, done: (result: undefined) => void);
    handleInput(data: string): void;
    render(width: number): string[];
    invalidate(): void;
    dispose(): void;
    private viewportHeight;
    private buildContentLines;
}
