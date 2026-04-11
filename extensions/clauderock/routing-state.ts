export type FallbackMode = "direct" | "fallback";
export type FallbackSource = "runtime" | "cache" | "manual";
export type FallbackCause = "quota-exhausted" | "oauth-rate-limit" | "manual" | "legacy-cache";
export type RoutingView = "hidden" | "direct" | "bedrock-fallback" | "fallback-unavailable";
export type QueuedNotification = "quota_exhausted" | "using_cached_fallback";

export interface LegacyFallbackCacheEntry {
  exhausted?: boolean;
  since?: string;
  reason?: string;
}

export interface RoutingModelState {
  provider?: string;
  modelId?: string;
  hasFallbackTarget: boolean;
}

export interface RoutingPresentationState {
  view: RoutingView;
  mode: FallbackMode;
  source: FallbackSource | null;
  cause: FallbackCause | null;
  fallbackActive: boolean;
  hasFallbackTarget: boolean;
  isAnthropicProvider: boolean;
  pendingNotification: QueuedNotification | null;
  sessionNotified: boolean;
  since: string | null;
  reason: string | null;
}

export interface RoutingStateController {
  initializeFromCache(cache: LegacyFallbackCacheEntry | null | undefined): void;
  beginSession(model: RoutingModelState): void;
  updateModel(model: RoutingModelState): void;
  activateFallback(input: {
    source: FallbackSource;
    cause: FallbackCause;
    reason?: string;
    since?: string;
    queueNotification?: QueuedNotification;
  }): void;
  manualOn(reason?: string): void;
  manualOff(): void;
  queueFallbackNotificationIfNeeded(): void;
  popQueuedNotification(): QueuedNotification | null;
  markSessionNotified(): void;
  getPresentationState(): RoutingPresentationState;
}

export function createRoutingStateController(): RoutingStateController {
  let mode: FallbackMode = "direct";
  let source: FallbackSource | null = null;
  let cause: FallbackCause | null = null;
  let since: string | null = null;
  let reason: string | null = null;
  let pendingNotification: QueuedNotification | null = null;
  let sessionNotified = false;
  let isAnthropicProvider = false;
  let hasFallbackTarget = false;

  const updateModel = (model: RoutingModelState): void => {
    isAnthropicProvider = model.provider === "anthropic";
    hasFallbackTarget = model.hasFallbackTarget;
  };

  return {
    initializeFromCache(cache) {
      if (!cache?.exhausted) return;

      mode = "fallback";
      source = "cache";
      cause = "legacy-cache";
      since = typeof cache.since === "string" ? cache.since : null;
      reason = typeof cache.reason === "string" ? cache.reason : null;
    },

    beginSession(model) {
      sessionNotified = false;
      updateModel(model);
    },

    updateModel,

    activateFallback(input) {
      mode = "fallback";
      source = input.source;
      cause = input.cause;
      since = input.since ?? new Date().toISOString();
      reason = input.reason ?? null;
      if (input.queueNotification) {
        pendingNotification = input.queueNotification;
      }
    },

    manualOn(manualReason = "manually forced via /clauderock on") {
      mode = "fallback";
      source = "manual";
      cause = "manual";
      since = new Date().toISOString();
      reason = manualReason;
    },

    manualOff() {
      mode = "direct";
      source = null;
      cause = null;
      since = null;
      reason = null;
      sessionNotified = false;
    },

    queueFallbackNotificationIfNeeded() {
      if (mode === "fallback" && !sessionNotified) {
        pendingNotification = "using_cached_fallback";
      }
    },

    popQueuedNotification() {
      const queued = pendingNotification;
      pendingNotification = null;
      return queued;
    },

    markSessionNotified() {
      sessionNotified = true;
    },

    getPresentationState() {
      let view: RoutingView;
      if (!isAnthropicProvider) {
        view = "hidden";
      } else if (mode === "direct") {
        view = "direct";
      } else if (hasFallbackTarget) {
        view = "bedrock-fallback";
      } else {
        view = "fallback-unavailable";
      }

      return {
        view,
        mode,
        source,
        cause,
        fallbackActive: mode === "fallback",
        hasFallbackTarget,
        isAnthropicProvider,
        pendingNotification,
        sessionNotified,
        since,
        reason,
      };
    },
  };
}
