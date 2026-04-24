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
/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;
/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc(events, channel, fn) {
    return events.on(channel, async (raw) => {
        const params = raw;
        try {
            const data = await fn(params);
            const reply = { success: true };
            if (data !== undefined)
                reply.data = data;
            events.emit(`${channel}:reply:${params.requestId}`, reply);
        }
        catch (err) {
            events.emit(`${channel}:reply:${params.requestId}`, {
                success: false, error: err?.message ?? String(err),
            });
        }
    });
}
/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps) {
    const { events, pi, getCtx, manager } = deps;
    const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
        return { version: PROTOCOL_VERSION };
    });
    const unsubSpawn = handleRpc(events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
        const ctx = getCtx();
        if (!ctx)
            throw new Error("No active session");
        return { id: manager.spawn(pi, ctx, type, prompt, options ?? {}) };
    });
    const unsubStop = handleRpc(events, "subagents:rpc:stop", ({ agentId }) => {
        if (!manager.abort(agentId))
            throw new Error("Agent not found");
    });
    return { unsubPing, unsubSpawn, unsubStop };
}
