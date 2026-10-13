import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTurnCeiling, parseTurnCheckIn, TURN_CEILING, TURN_CHECK_IN, watchTurns } from "../src/turn-ceiling.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseTurnCeiling", () => {
  it("defaults to 300 and accepts a positive integer override", () => {
    expect(TURN_CEILING).toBe(300);
    expect(parseTurnCeiling(undefined)).toBe(300);
    expect(parseTurnCeiling("12")).toBe(12);
    expect(parseTurnCeiling(" 7 ")).toBe(7);
  });

  it.each(["", "  ", "0", "-3", "2.5", "abc", "Infinity", "NaN"])("falls back to 300 for %j", (value) => {
    expect(parseTurnCeiling(value)).toBe(300);
  });
});

describe("parseTurnCheckIn", () => {
  it("defaults to 150 and accepts a positive integer override", () => {
    expect(TURN_CHECK_IN).toBe(150);
    expect(parseTurnCheckIn(undefined)).toBe(150);
    expect(parseTurnCheckIn("12")).toBe(12);
  });

  it.each(["", "0", "-3", "2.5", "abc"])("falls back to 150 for %j", (value) => {
    expect(parseTurnCheckIn(value)).toBe(150);
  });
});

describe("watchTurns check-in", () => {
  function fakeSession() {
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => { listeners.splice(listeners.indexOf(listener), 1); };
      },
      steer: vi.fn(),
      abort: vi.fn(),
    };
    const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
    return {
      session: session as unknown as AgentSession,
      steer: session.steer,
      toolTurn: () => emit({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] }, toolResults: [] }),
      finishedTurn: () => emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "DONE" }] }, toolResults: [] }),
    };
  }

  it("fires once, with the threshold read at start, on the first unfinished turn at or past it", () => {
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "2");
    const { session, steer, toolTurn, finishedTurn } = fakeSession();
    const onCheckIn = vi.fn();
    watchTurns(session, { onCheckIn });
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "50");
    toolTurn();
    finishedTurn();
    expect(onCheckIn).not.toHaveBeenCalled();
    toolTurn();
    toolTurn();
    toolTurn();
    expect(onCheckIn).toHaveBeenCalledExactlyOnceWith(2);
    // The subagent itself never hears about the check-in.
    expect(steer).not.toHaveBeenCalled();
  });

  it("checks in again for a new Execution", () => {
    vi.stubEnv("SUBAGENT_TURN_CHECK_IN", "1");
    const { session, toolTurn } = fakeSession();
    const first = vi.fn();
    const second = vi.fn();
    const watch = watchTurns(session, { onCheckIn: first });
    toolTurn();
    watch.unsubscribe();
    watchTurns(session, { onCheckIn: second });
    toolTurn();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledExactlyOnceWith(1);
  });
});
