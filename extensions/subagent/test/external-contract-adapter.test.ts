import { describe, expect, it, vi } from "vitest";
import { emitCompactedContract } from "../src/external-contract-adapter.js";

describe("emitCompactedContract", () => {
  it("emits subagents:compacted with correct event name and payload", () => {
    const emit = vi.fn();
    const pi = { events: { emit }, appendEntry: vi.fn() };

    emitCompactedContract(
      pi,
      { id: "abc123", type: "general-purpose" },
      { reason: "context_length", tokensBefore: 50000, compactionCount: 1 }
    );

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("subagents:compacted", {
      id: "abc123",
      type: "general-purpose",
      reason: "context_length",
      tokensBefore: 50000,
      compactionCount: 1,
    });
  });

  it("includes compactionCount correctly in payload", () => {
    const emit = vi.fn();
    const pi = { events: { emit }, appendEntry: vi.fn() };

    emitCompactedContract(
      pi,
      { id: "xyz789", type: "Explore" },
      { reason: "manual", tokensBefore: 12345, compactionCount: 3 }
    );

    const [, payload] = emit.mock.calls[0];
    expect(payload).toMatchObject({ compactionCount: 3, tokensBefore: 12345 });
  });

  it("does not call appendEntry", () => {
    const appendEntry = vi.fn();
    const pi = { events: { emit: vi.fn() }, appendEntry };

    emitCompactedContract(
      pi,
      { id: "id1", type: "Plan" },
      { reason: "auto", tokensBefore: 1000, compactionCount: 0 }
    );

    expect(appendEntry).not.toHaveBeenCalled();
  });
});
