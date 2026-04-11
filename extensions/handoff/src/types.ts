export const LOCAL_PLAN_URI = "local://PLAN.md";
export const LOCAL_HANDOFF_BRIEFING_URI = "local://HANDOFF.md";
export const LOCAL_HANDOFF_AUTHORITY_URI = "local://HANDOFF.json";

export const HANDOFF_PERSISTED_STATUSES = ["pending", "consumed"] as const;
export type HandoffPersistedStatus = (typeof HANDOFF_PERSISTED_STATUSES)[number];

export const HANDOFF_READINESS_STATES = ["not-ready", "missing", "stale", "ready"] as const;
export type HandoffReadinessState = (typeof HANDOFF_READINESS_STATES)[number];

export const HANDOFF_MISSING_RESOURCES = ["plan", "handoff-authority", "handoff-briefing"] as const;
export type HandoffMissingResource = (typeof HANDOFF_MISSING_RESOURCES)[number];

export const HANDOFF_STARTUP_STATUSES = ["bootstrapping", "awaiting-handlers"] as const;
export type HandoffStartupStatus = (typeof HANDOFF_STARTUP_STATUSES)[number];

export type HandoffCapability = "ping" | "prepare" | "get" | "mark-consumed" | "clear";

export type HandoffExecutionKickoffStatus = "accepted" | "invalid";
export interface HandoffExecutionKickoffEvent {
  handoffId: string;
  status: HandoffExecutionKickoffStatus;
  reason?: string;
}

export interface HandoffAuthorityRecord {
  handoffId: string;
  status: HandoffPersistedStatus;
  producerMode: string;
  targetMode: string;
  kickoffPrompt: string;
  createdAt: string;
  consumedAt?: string;
  planHash: string;
  planTitle?: string;
  planUri: typeof LOCAL_PLAN_URI;
  briefingUri: typeof LOCAL_HANDOFF_BRIEFING_URI;
  authorityUri: typeof LOCAL_HANDOFF_AUTHORITY_URI;
}

export interface PlanAuthoritySnapshot {
  path: string;
  uri: typeof LOCAL_PLAN_URI;
  content: string;
  planHash: string;
  planTitle?: string;
}

export interface HandoffFreshnessCheck {
  isStale: boolean;
  storedPlanHash: string;
  latestPlanHash: string;
}

export interface HandoffReadiness {
  state: HandoffReadinessState;
  ready: boolean;
  reason?: string;
  startupStatus?: HandoffStartupStatus;
  missingResource?: HandoffMissingResource;
  handoffId?: string;
  handoffStatus?: HandoffPersistedStatus;
  storedPlanHash?: string;
  latestPlanHash?: string;
  planTitle?: string;
}

export interface HandoffProtocolMetadata {
  version: number;
  ready: boolean;
  capabilities: readonly HandoffCapability[];
  readiness: HandoffReadiness;
}

export interface HandoffRpcSuccess<T = void> {
  success: true;
  version: number;
  data?: T;
}

export interface HandoffRpcFailure {
  success: false;
  version: number;
  error: string;
  code?: string;
  readiness?: HandoffReadiness;
}

export type HandoffRpcReply<T = void> = HandoffRpcSuccess<T> | HandoffRpcFailure;

export interface HandoffRequestEnvelope<TPayload = void> {
  version: number;
  requestId: string;
  source?: string;
  payload: TPayload;
}

export type HandoffPingRequest = HandoffRequestEnvelope<Record<string, never>>;

export interface HandoffPreparePayload {
  handoffId: string;
  briefing: string;
  producerMode: string;
  targetMode: string;
  kickoffPrompt: string;
  createdAt?: string;
}

export type HandoffPrepareRequest = HandoffRequestEnvelope<HandoffPreparePayload>;
export type HandoffGetRequest = HandoffRequestEnvelope<Record<string, never>>;

export interface HandoffMarkConsumedPayload {
  consumedAt?: string;
}

export type HandoffMarkConsumedRequest = HandoffRequestEnvelope<HandoffMarkConsumedPayload>;
export type HandoffClearRequest = HandoffRequestEnvelope<Record<string, never>>;

export type HandoffPingData = HandoffProtocolMetadata;
export type HandoffReadyEvent = HandoffProtocolMetadata;

export interface HandoffPrepareData {
  authority: HandoffAuthorityRecord;
  briefingPath: string;
  authorityPath: string;
  readiness: HandoffReadiness;
}

export interface HandoffGetData {
  authority?: HandoffAuthorityRecord;
  briefing?: string;
  readiness: HandoffReadiness;
}

export interface HandoffMarkConsumedData {
  authority?: HandoffAuthorityRecord;
  readiness: HandoffReadiness;
}

export interface HandoffResolvedState {
  authority?: HandoffAuthorityRecord;
  briefing?: string;
  plan?: PlanAuthoritySnapshot;
  freshness?: HandoffFreshnessCheck;
  readiness: HandoffReadiness;
}
