import { describe, expect, it } from "vitest";
import {
  HANDOFF_CAPABILITIES,
  HANDOFF_CLEAR_CHANNEL,
  HANDOFF_GET_CHANNEL,
  HANDOFF_MARK_CONSUMED_CHANNEL,
  HANDOFF_PING_CHANNEL,
  HANDOFF_PREPARE_CHANNEL,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_READY_EVENT,
  HANDOFF_RPC_CHANNELS,
  createBootstrappingReadiness,
  createErrorReply,
  createHandlersUnwiredReadiness,
  createMissingReadiness,
  createPingData,
  createReadyEvent,
  createReplyChannel,
  createRequestEnvelope,
  createStaleReadiness,
  createSuccessReply,
} from "../src/protocol.js";

describe("handoff protocol contract", () => {
  it("exposes stable channel names and versioned request envelopes", () => {
    expect(HANDOFF_READY_EVENT).toBe("handoff:ready");
    expect(HANDOFF_PING_CHANNEL).toBe("handoff:rpc:ping");
    expect(HANDOFF_PREPARE_CHANNEL).toBe("handoff:rpc:prepare");
    expect(HANDOFF_GET_CHANNEL).toBe("handoff:rpc:get");
    expect(HANDOFF_MARK_CONSUMED_CHANNEL).toBe("handoff:rpc:mark-consumed");
    expect(HANDOFF_CLEAR_CHANNEL).toBe("handoff:rpc:clear");
    expect(HANDOFF_RPC_CHANNELS).toEqual({
      ping: HANDOFF_PING_CHANNEL,
      prepare: HANDOFF_PREPARE_CHANNEL,
      get: HANDOFF_GET_CHANNEL,
      markConsumed: HANDOFF_MARK_CONSUMED_CHANNEL,
      clear: HANDOFF_CLEAR_CHANNEL,
    });
    expect(createReplyChannel(HANDOFF_GET_CHANNEL, "req-1")).toBe("handoff:rpc:get:reply:req-1");
    expect(HANDOFF_CAPABILITIES).toEqual(["ping", "prepare", "get", "mark-consumed", "clear"]);
    expect(createRequestEnvelope("req-1", { handoffId: "handoff-1" }, "test")).toEqual({
      version: HANDOFF_PROTOCOL_VERSION,
      requestId: "req-1",
      source: "test",
      payload: { handoffId: "handoff-1" },
    });
  });

  it("makes startup ordering explicit in readiness helpers", () => {
    expect(createBootstrappingReadiness()).toEqual({
      state: "not-ready",
      ready: false,
      reason: "Handoff extension is still bootstrapping.",
      startupStatus: "bootstrapping",
      handoffId: undefined,
      handoffStatus: undefined,
      storedPlanHash: undefined,
      planTitle: undefined,
    });

    expect(createHandlersUnwiredReadiness()).toEqual({
      state: "not-ready",
      ready: false,
      reason: "Handoff authority handlers are not wired yet.",
      startupStatus: "awaiting-handlers",
      handoffId: undefined,
      handoffStatus: undefined,
      storedPlanHash: undefined,
      planTitle: undefined,
    });
  });

  it("encodes missing and stale readiness explicitly", () => {
    const missing = createMissingReadiness("handoff-authority", "local://HANDOFF.json is missing.");
    expect(createPingData(missing)).toEqual({
      version: HANDOFF_PROTOCOL_VERSION,
      ready: false,
      capabilities: HANDOFF_CAPABILITIES,
      readiness: {
        state: "missing",
        ready: false,
        reason: "local://HANDOFF.json is missing.",
        missingResource: "handoff-authority",
        handoffId: undefined,
        handoffStatus: undefined,
        storedPlanHash: undefined,
        planTitle: undefined,
      },
    });

    const stale = createStaleReadiness(
      {
        handoffId: "handoff-1",
        status: "pending",
        planHash: "stored-hash",
        planTitle: "Ship feature",
      },
      "latest-hash",
    );
    expect(stale).toMatchObject({
      state: "stale",
      ready: false,
      handoffId: "handoff-1",
      handoffStatus: "pending",
      storedPlanHash: "stored-hash",
      latestPlanHash: "latest-hash",
      planTitle: "Ship feature",
    });
    expect(createReadyEvent(stale)).toEqual(createPingData(stale));
  });

  it("returns versioned success and error envelopes", () => {
    expect(createSuccessReply({ ok: true })).toEqual({
      success: true,
      version: HANDOFF_PROTOCOL_VERSION,
      data: { ok: true },
    });

    expect(createErrorReply(new Error("boom"), { code: "E_BROKEN" })).toEqual({
      success: false,
      version: HANDOFF_PROTOCOL_VERSION,
      error: "boom",
      code: "E_BROKEN",
      readiness: undefined,
    });
  });
});
