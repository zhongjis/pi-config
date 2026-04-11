import type { QueuedNotification, RoutingPresentationState, RoutingView } from "./routing-state";

type ThemeColor = "accent" | "dim" | "error" | "warning";
type NotificationLevel = "info" | "warning";

interface ThemeLike {
  fg(color: string, text: string): string;
}

interface RoutePresentationSpec {
  text: string;
  dotColor: ThemeColor;
  labelColor: ThemeColor;
}

interface PresentationOptions {
  preferModeWhenHidden?: boolean;
}

export interface RoutingNotificationPresentation {
  level: NotificationLevel;
  message: string;
}

export interface RoutingSummaryOptions extends PresentationOptions {
  since?: string | null;
  reason?: string | null;
}

const ROUTE_PRESENTATION: Record<Exclude<RoutingView, "hidden">, RoutePresentationSpec> = {
  direct: {
    text: "Claude direct",
    dotColor: "dim",
    labelColor: "dim",
  },
  "bedrock-fallback": {
    text: "Bedrock fallback",
    dotColor: "warning",
    labelColor: "accent",
  },
  "fallback-unavailable": {
    text: "Fallback unavailable",
    dotColor: "warning",
    labelColor: "error",
  },
};

function getPresentationView(
  state: RoutingPresentationState,
  options: PresentationOptions = {},
): Exclude<RoutingView, "hidden"> | null {
  if (state.view !== "hidden") {
    return state.view;
  }

  if (!options.preferModeWhenHidden) {
    return null;
  }

  if (!state.fallbackActive) {
    return "direct";
  }

  return state.hasFallbackTarget ? "bedrock-fallback" : "fallback-unavailable";
}

function getRoutePresentation(
  state: RoutingPresentationState,
  options: PresentationOptions = {},
): RoutePresentationSpec | null {
  const view = getPresentationView(state, options);
  return view ? ROUTE_PRESENTATION[view] : null;
}

function inferCause(
  state: RoutingPresentationState,
): RoutingPresentationState["cause"] | "quota-exhausted" | "oauth-rate-limit" {
  if (state.cause && state.cause !== "legacy-cache") {
    return state.cause;
  }

  const reason = state.reason?.toLowerCase() ?? "";
  if (
    reason.includes("billing")
    || reason.includes("credit")
    || reason.includes("quota")
    || reason.includes("spend limit")
  ) {
    return "quota-exhausted";
  }

  if (reason.includes("rate limit") || reason.includes("too many requests")) {
    return "oauth-rate-limit";
  }

  return state.cause;
}

function getCurrentFallbackCauseText(state: RoutingPresentationState): string {
  switch (inferCause(state)) {
    case "quota-exhausted":
      return "Claude billing/quota exhausted";
    case "oauth-rate-limit":
      return "Claude rate limit hit";
    case "manual":
      return "Bedrock fallback enabled manually";
    case "legacy-cache":
      return "Bedrock fallback restored from a previous session";
    default:
      return "Claude direct route unavailable";
  }
}

function getPreviousFallbackCauseText(state: RoutingPresentationState): string {
  switch (inferCause(state)) {
    case "quota-exhausted":
      return "Claude billing/quota was previously exhausted";
    case "oauth-rate-limit":
      return "Claude API was previously rate-limited";
    case "manual":
      return "Bedrock fallback is enabled manually";
    case "legacy-cache":
      return "Bedrock fallback was restored from a previous session";
    default:
      return "Bedrock fallback is currently armed";
  }
}

function formatRouteName(
  theme: ThemeLike,
  state: RoutingPresentationState,
  options: PresentationOptions = {},
): string | null {
  const route = getRoutePresentation(state, options);
  if (!route) {
    return null;
  }

  return theme.fg(route.labelColor, route.text);
}

export function formatRouteLabel(
  theme: ThemeLike,
  state: RoutingPresentationState,
  options: PresentationOptions = {},
): string | null {
  const route = getRoutePresentation(state, options);
  if (!route) {
    return null;
  }

  return theme.fg(route.dotColor, "●") + theme.fg(route.labelColor, ` ${route.text}`);
}

export function formatStatusBar(
  theme: ThemeLike,
  state: RoutingPresentationState,
): string | undefined {
  return formatRouteLabel(theme, state) ?? undefined;
}

export function formatQueuedNotification(
  theme: ThemeLike,
  notification: QueuedNotification,
  state: RoutingPresentationState,
): RoutingNotificationPresentation {
  const offCommand = theme.fg("accent", "/clauderock off");

  if (notification === "quota_exhausted") {
    const headline = theme.fg("warning", `⚠ ${getCurrentFallbackCauseText(state)}`);
    if (state.view === "bedrock-fallback") {
      return {
        level: "warning",
        message: `${headline} — using ${formatRouteName(theme, state) ?? "Bedrock fallback"}`,
      };
    }

    if (state.view === "fallback-unavailable") {
      return {
        level: "warning",
        message: `${headline} — ${theme.fg("error", "Bedrock fallback unavailable for this model")}`,
      };
    }

    return {
      level: "warning",
      message: headline,
    };
  }

  if (state.view === "fallback-unavailable") {
    return {
      level: "warning",
      message:
        `${theme.fg("warning", "⚠ Fallback unavailable")} — fallback is armed, but this model has no Bedrock route. `
        + `Run ${offCommand} to retry direct API.`,
    };
  }

  return {
    level: "info",
    message:
      `Using ${formatRouteName(theme, state, { preferModeWhenHidden: true }) ?? "Bedrock fallback"} — ${getPreviousFallbackCauseText(state)}. `
      + `Run ${offCommand} to retry direct API.`,
  };
}

export function formatRoutingSummary(
  theme: ThemeLike,
  state: RoutingPresentationState,
  options: RoutingSummaryOptions = {},
): string | null {
  const routeLabel = formatRouteLabel(theme, state, { preferModeWhenHidden: true });
  if (!routeLabel) {
    return null;
  }

  const since = options.since ?? state.since;
  const reason = options.reason ?? state.reason;

  if (state.view === "hidden") {
    if (!state.fallbackActive) {
      return `${routeLabel} idle. Current model is not Anthropic.`;
    }

    if (state.hasFallbackTarget) {
      return `${routeLabel} armed since ${since ?? "this session"}${reason ? ` — ${reason}` : ""}. Current model is not Anthropic.`;
    }

    return `${routeLabel} — fallback is armed${since ? ` since ${since}` : ""}, but this model has no Bedrock route${reason ? ` — ${reason}` : ""}. Current model is not Anthropic.`;
  }

  if (!state.fallbackActive) {
    return `${routeLabel} active. Bedrock fallback on standby.`;
  }

  if (state.hasFallbackTarget) {
    return `${routeLabel} active since ${since ?? "this session"}${reason ? ` — ${reason}` : ""}.`;
  }

  return `${routeLabel} — fallback is armed${since ? ` since ${since}` : ""}, but this model has no Bedrock route${reason ? ` — ${reason}` : ""}.`;
}

export function formatRoutingHealthLine(
  theme: ThemeLike,
  state: RoutingPresentationState,
  options: RoutingSummaryOptions = {},
): string | null {
  const routeLabel = formatRouteLabel(theme, state, { preferModeWhenHidden: true });
  if (!routeLabel) {
    return null;
  }

  const since = options.since ?? state.since;

  if (state.view === "hidden") {
    if (!state.fallbackActive) {
      return `${routeLabel} — Idle (current model is not Anthropic).`;
    }

    if (state.hasFallbackTarget) {
      return `${routeLabel} — Armed since ${since ?? "this session"} (current model is not Anthropic).`;
    }

    return `${routeLabel} — Armed${since ? ` since ${since}` : ""}, but this model has no Bedrock route (current model is not Anthropic).`;
  }

  if (!state.fallbackActive) {
    return `${routeLabel} — Active (Bedrock fallback on standby).`;
  }

  if (state.hasFallbackTarget) {
    return `${routeLabel} — Active since ${since ?? "this session"}.`;
  }

  return `${routeLabel} — Armed${since ? ` since ${since}` : ""}, but this model has no Bedrock route.`;
}
