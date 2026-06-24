/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, stop, and consume RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import { PROTOCOL_VERSION } from "./constants.js";
import { registerRpcHandler } from "../../lib/rpc.js";

export { PROTOCOL_VERSION };

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}


/** RPC protocol version — bumped when the envelope or method contracts change. */

/** Minimal AgentManager interface needed by the RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
  getRecord(id: string): any | undefined;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubConsume: () => void;
}

/**
 * Register ping, spawn, stop, and consume RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { pi, getCtx, manager } = deps;

  const unsubPing = registerRpcHandler(pi as any, "subagents", "ping", () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = registerRpcHandler(pi as any, "subagents", "spawn", (raw) => {
    const { type, prompt, options } = raw as { type: string; prompt: string; options?: any };
    const ctx = getCtx();
    if (!ctx) throw new Error("No active session");
    return { id: manager.spawn(pi, ctx, type, prompt, options ?? {}) };
  });

  const unsubStop = registerRpcHandler(pi as any, "subagents", "stop", (raw) => {
    const { agentId } = raw as { agentId: string };
    if (!manager.abort(agentId)) throw new Error("Agent not found");
  });

  const unsubConsume = registerRpcHandler(pi as any, "subagents", "consume", (raw) => {
    const { agentId } = raw as { agentId: string };
    const record = manager.getRecord(agentId);
    if (!record) return { consumed: false };
    if (record.status !== "running" && record.status !== "queued") {
      if (record.run) {
        record.run.publish({ kind: "consumed" });
      } else {
        record.resultConsumed = true;
      }
      return { consumed: true };
    }
    return { consumed: false };
  });

  return { unsubPing, unsubSpawn, unsubStop, unsubConsume };
}
