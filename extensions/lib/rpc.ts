/**
 * Shared cross-extension RPC primitive over the `pi.events` event bus.
 *
 * Frozen wire contract (see extensions/CONVENTIONS.md):
 *   - Request channel: `<namespace>:rpc:<method>`
 *   - Reply channel:   `<namespace>:rpc:<method>:reply:${requestId}`
 *   - Every request payload includes `requestId`.
 *   - Reply envelope:  `{ success: true, data? } | { success: false, error: string }`
 *   - Temporary reply listeners unsubscribe on settle, timeout, or abort.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Default reply timeout in milliseconds when `opts.timeout` is not supplied. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Frozen reply envelope shape — do not change. */
type RpcReply<T = unknown> =
  | { success: true; data?: T }
  | { success: false; error: string };

/**
 * Per-`pi`-instance registry of request channels, used to detect re-registration
 * of the same namespace+method. A `WeakMap` keeps tracking scoped to the live
 * extension instance so independent runtimes (and tests) never cross-contaminate.
 */
const registeredChannels = new WeakMap<object, Set<string>>();

/** Build the request channel `<namespace>:rpc:<method>`. */
function buildRequestChannel(namespace: string, method: string): string {
  return `${namespace}:rpc:${method}`;
}

/** Build the per-request reply channel `${channel}:reply:${requestId}`. */
function buildReplyChannel(channel: string, requestId: string): string {
  return `${channel}:reply:${requestId}`;
}

/**
 * Issue an RPC request and resolve with the reply payload.
 *
 * Subscribes to a per-request reply channel, emits the request (with a unique
 * `requestId`), and tears the listener down on the first of settle/timeout.
 */
export function rpcCall<T = unknown>(
  pi: ExtensionAPI,
  namespace: string,
  method: string,
  args: unknown,
  opts?: { timeout?: number },
): Promise<T> {
  const channel = buildRequestChannel(namespace, method);
  const requestId = randomUUID();
  const timeoutMs = opts?.timeout ?? DEFAULT_RPC_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      unsub();
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${channel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsub = pi.events.on(buildReplyChannel(channel, requestId), (raw: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      const reply = raw as RpcReply<T>;
      if (reply?.success) resolve(reply.data as T);
      else {
        const failure = reply as { success: false; error: string } | null | undefined;
        reject(new Error(failure?.error ?? `${channel} failed`));
      }
    });

    // Payload always carries `requestId` last so it wins over any caller-supplied key.
    const payload =
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? { ...(args as Record<string, unknown>), requestId }
        : { requestId, args };
    pi.events.emit(channel, payload);
  });
}

/**
 * Register an RPC handler for `<namespace>:rpc:<method>`.
 *
 * The handler receives the raw request payload and the extracted `requestId`,
 * and its resolved value (or thrown error) is wrapped in the frozen reply
 * envelope and emitted on the per-request reply channel. Re-registering the same
 * namespace+method on the same `pi` emits a `lib.rpc.handler-replaced` warning on
 * the event bus and does not throw. Returns an unsubscribe function.
 */
export function registerRpcHandler(
  pi: ExtensionAPI,
  namespace: string,
  method: string,
  handler: (args: unknown, requestId: string) => Promise<unknown> | unknown,
): () => void {
  const channel = buildRequestChannel(namespace, method);

  const channels = registeredChannels.get(pi) ?? new Set<string>();
  if (channels.has(channel)) {
    pi.events.emit("lib.rpc.handler-replaced", {
      code: "lib.rpc.handler-replaced",
      namespace,
      method,
      channel,
    });
  }
  channels.add(channel);
  registeredChannels.set(pi, channels);

  const unsub = pi.events.on(channel, async (raw: unknown) => {
    const requestId = (raw as { requestId?: string })?.requestId ?? "";
    const replyChannel = buildReplyChannel(channel, requestId);
    try {
      const data = await handler(raw, requestId);
      const reply: RpcReply = { success: true };
      if (data !== undefined) reply.data = data;
      pi.events.emit(replyChannel, reply);
    } catch (err: any) {
      pi.events.emit(replyChannel, {
        success: false,
        error: err?.message ?? String(err),
      } satisfies RpcReply);
    }
  });

  return () => {
    unsub();
    channels.delete(channel);
  };
}
