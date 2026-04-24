/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */
/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
    on(event: string, handler: (data: unknown) => void): () => void;
    emit(event: string, data: unknown): void;
}
/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> = {
    success: true;
    data?: T;
} | {
    success: false;
    error: string;
};
/** RPC protocol version — bumped when the envelope or method contracts change. */
export declare const PROTOCOL_VERSION = 2;
/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
    spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
    abort(id: string): boolean;
}
export interface RpcDeps {
    events: EventBus;
    pi: unknown;
    getCtx: () => unknown | undefined;
    manager: SpawnCapable;
}
export interface RpcHandle {
    unsubPing: () => void;
    unsubSpawn: () => void;
    unsubStop: () => void;
}
/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export declare function registerRpcHandlers(deps: RpcDeps): RpcHandle;
