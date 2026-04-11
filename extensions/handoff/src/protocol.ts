import type {
  HandoffAuthorityRecord,
  HandoffCapability,
  HandoffExecutionKickoffEvent,
  HandoffMissingResource,
  HandoffPingData,
  HandoffReadiness,
  HandoffReadyEvent,
  HandoffRequestEnvelope,
  HandoffRpcReply,
  HandoffStartupStatus,
} from "./types.js";

export const HANDOFF_PROTOCOL_VERSION = 1;

export const HANDOFF_READY_EVENT = "handoff:ready";
export const HANDOFF_PING_CHANNEL = "handoff:rpc:ping";
export const HANDOFF_PREPARE_CHANNEL = "handoff:rpc:prepare";
export const HANDOFF_GET_CHANNEL = "handoff:rpc:get";
export const HANDOFF_MARK_CONSUMED_CHANNEL = "handoff:rpc:mark-consumed";
export const HANDOFF_CLEAR_CHANNEL = "handoff:rpc:clear";
export const HANDOFF_EXECUTION_KICKOFF_EVENT = "handoff:execution-kickoff";
export const HOUTU_EXECUTION_HANDOFF_SENTINEL_PREFIX = "__PI_HANDOFF_EXECUTE__:";

export const HANDOFF_RPC_CHANNELS = {
  ping: HANDOFF_PING_CHANNEL,
  prepare: HANDOFF_PREPARE_CHANNEL,
  get: HANDOFF_GET_CHANNEL,
  markConsumed: HANDOFF_MARK_CONSUMED_CHANNEL,
  clear: HANDOFF_CLEAR_CHANNEL,
} as const;

export const HANDOFF_CAPABILITIES = ["ping", "prepare", "get", "mark-consumed", "clear"] as const satisfies readonly HandoffCapability[];

type HandoffAuthoritySummary = Pick<HandoffAuthorityRecord, "handoffId" | "status" | "planHash" | "planTitle">;

function getAuthoritySummary(authority?: Partial<HandoffAuthoritySummary>): Pick<
  HandoffReadiness,
  "handoffId" | "handoffStatus" | "storedPlanHash" | "planTitle"
> {
  return {
    handoffId: authority?.handoffId,
    handoffStatus: authority?.status,
    storedPlanHash: authority?.planHash,
    planTitle: authority?.planTitle,
  };
}

export function createReplyChannel(channel: string, requestId: string): string {
  return `${channel}:reply:${requestId}`;
}

export function createRequestEnvelope<TPayload>(
  requestId: string,
  payload: TPayload,
  source?: string,
): HandoffRequestEnvelope<TPayload> {
  return {
    version: HANDOFF_PROTOCOL_VERSION,
    requestId,
    source,
    payload,
  };
}

export function parseExecutionKickoffSentinel(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(HOUTU_EXECUTION_HANDOFF_SENTINEL_PREFIX)) {
    return undefined;
  }

  const handoffId = trimmed.slice(HOUTU_EXECUTION_HANDOFF_SENTINEL_PREFIX.length).trim();
  return handoffId || undefined;
}

export function createExecutionKickoffEvent(
  event: HandoffExecutionKickoffEvent,
): HandoffExecutionKickoffEvent {
  return event;
}

export function createNotReadyReadiness(
  reason: string,
  options: {
    startupStatus?: HandoffStartupStatus;
    authority?: Partial<HandoffAuthoritySummary>;
  } = {},
): HandoffReadiness {
  return {
    state: "not-ready",
    ready: false,
    reason,
    startupStatus: options.startupStatus,
    ...getAuthoritySummary(options.authority),
  };
}

export function createBootstrappingReadiness(
  reason = "Handoff extension is still bootstrapping.",
): HandoffReadiness {
  return createNotReadyReadiness(reason, { startupStatus: "bootstrapping" });
}

export function createHandlersUnwiredReadiness(
  reason = "Handoff authority handlers are not wired yet.",
): HandoffReadiness {
  return createNotReadyReadiness(reason, { startupStatus: "awaiting-handlers" });
}

export function createMissingReadiness(
  missingResource: HandoffMissingResource,
  reason: string,
  authority?: Partial<HandoffAuthoritySummary>,
): HandoffReadiness {
  return {
    state: "missing",
    ready: false,
    reason,
    missingResource,
    ...getAuthoritySummary(authority),
  };
}

export function createStaleReadiness(
  authority: HandoffAuthoritySummary,
  latestPlanHash: string,
  reason = "HANDOFF.json planHash does not match the latest local://PLAN.md.",
): HandoffReadiness {
  return {
    state: "stale",
    ready: false,
    reason,
    latestPlanHash,
    ...getAuthoritySummary(authority),
  };
}

export function createReadyReadiness(
  authority: HandoffAuthoritySummary,
  latestPlanHash = authority.planHash,
): HandoffReadiness {
  return {
    state: "ready",
    ready: true,
    latestPlanHash,
    ...getAuthoritySummary(authority),
  };
}

export function createPingData(readiness: HandoffReadiness): HandoffPingData {
  return {
    version: HANDOFF_PROTOCOL_VERSION,
    ready: readiness.ready,
    capabilities: HANDOFF_CAPABILITIES,
    readiness,
  };
}

export function createReadyEvent(readiness: HandoffReadiness): HandoffReadyEvent {
  return createPingData(readiness);
}

export function createSuccessReply<T>(data?: T): HandoffRpcReply<T> {
  return data === undefined
    ? { success: true, version: HANDOFF_PROTOCOL_VERSION }
    : { success: true, version: HANDOFF_PROTOCOL_VERSION, data };
}

export function createErrorReply(
  error: unknown,
  options: { code?: string; readiness?: HandoffReadiness } = {},
): HandoffRpcReply<never> {
  return {
    success: false,
    version: HANDOFF_PROTOCOL_VERSION,
    error: error instanceof Error ? error.message : String(error),
    code: options.code,
    readiness: options.readiness,
  };
}
