/**
 * group-join.ts — Manages grouped background agent completion notifications.
 *
 * Instead of each agent individually nudging the main agent on completion,
 * agents in a group are held until all complete (or a timeout fires),
 * then a single consolidated notification is sent.
 */
import type { AgentRecord } from "./types.js";
export type DeliveryCallback = (records: AgentRecord[], partial: boolean) => void;
export declare class GroupJoinManager {
    private deliverCb;
    private groupTimeout;
    private groups;
    private agentToGroup;
    constructor(deliverCb: DeliveryCallback, groupTimeout?: number);
    /** Register a group of agent IDs that should be joined. */
    registerGroup(groupId: string, agentIds: string[]): void;
    /**
     * Called when an agent completes.
     * Returns:
     * - 'pass'      — agent is not grouped, caller should send individual nudge
     * - 'held'      — result held, waiting for group completion
     * - 'delivered'  — this completion triggered the group notification
     */
    onAgentComplete(record: AgentRecord): 'delivered' | 'held' | 'pass';
    private onTimeout;
    private deliver;
    private cleanupGroup;
    /** Check if an agent is in a group. */
    isGrouped(agentId: string): boolean;
    dispose(): void;
}
