import { describe, expect, it, vi } from "vitest";
import { registerRpcHandler, rpcCall } from "../rpc.js";

/** Minimal in-process event bus matching the `pi.events` surface. */
function createEventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event: string, handler: (data: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => {
        listeners.get(event)?.delete(handler);
      };
    },
    emit(event: string, data: unknown) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

/** Fresh fake `pi` (only `events` is exercised by the RPC primitive). */
function createPi() {
  return { events: createEventBus() } as any;
}

describe("lib/rpc", () => {
  it("round-trips a successful call: handler reply reaches the caller", async () => {
    const pi = createPi();
    registerRpcHandler(pi, "demo", "echo", (args) => {
      const { value } = args as { value: number };
      return { doubled: value * 2 };
    });

    const result = await rpcCall<{ doubled: number }>(pi, "demo", "echo", { value: 21 });
    expect(result).toEqual({ doubled: 42 });
  });

  it("rejects after the timeout when no handler replies", async () => {
    const pi = createPi();
    // No handler registered on this channel.
    await expect(
      rpcCall(pi, "demo", "never", { x: 1 }, { timeout: 25 }),
    ).rejects.toThrow(/timed out/);
  });

  it("rejects with the handler's error message on a failure reply", async () => {
    const pi = createPi();
    registerRpcHandler(pi, "demo", "boom", () => {
      throw new Error("handler exploded");
    });

    await expect(rpcCall(pi, "demo", "boom", {})).rejects.toThrow("handler exploded");
  });

  it("assigns a unique requestId to every concurrent call", async () => {
    const pi = createPi();
    const seen: string[] = [];
    registerRpcHandler(pi, "demo", "id", (_args, requestId) => {
      seen.push(requestId);
      return { requestId };
    });

    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => rpcCall<{ requestId: string }>(pi, "demo", "id", { i })),
    );

    const ids = results.map((r) => r.requestId);
    expect(seen).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);
    expect(new Set(seen).size).toBe(N);
  });

  it("warns (lib.rpc.handler-replaced) without throwing when a method is re-registered", () => {
    const pi = createPi();
    const warned = vi.fn();
    pi.events.on("lib.rpc.handler-replaced", warned);

    registerRpcHandler(pi, "demo", "dup", () => "first");
    expect(() => registerRpcHandler(pi, "demo", "dup", () => "second")).not.toThrow();

    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "lib.rpc.handler-replaced",
        namespace: "demo",
        method: "dup",
      }),
    );
  });
});
