import { clearCache, readCache, writeCache } from "./cache";
import {
  type AwsBedrockHealthEntry,
  type AwsBedrockHealthResult,
  type ClaudeApiHealthResult,
  runClauderockHealthChecks,
} from "./health-check";
import type { RoutingStateController } from "./routing-state";
import { formatRoutingHealthLine, formatRoutingSummary } from "./status-presentation";

interface CommandArgumentCompletion {
  value: string;
  label: string;
}

interface CommandRegistrationAPI {
  registerCommand(
    name: string,
    definition: {
      description: string;
      getArgumentCompletions(prefix: string): CommandArgumentCompletion[] | null;
      handler(args: string, ctx: CommandContext): Promise<void>;
    },
  ): void;
}


interface ThemeLike {
  fg(color: string, text: string): string;
}

interface CommandContext {
  ui: {
    theme: ThemeLike;
    notify(message: string, level: "info" | "warning"): void;
    setStatus(key: string, text: string | undefined): void;
  };
}

export interface ClauderockCommandDependencies {
  routingState: RoutingStateController;
  syncStatusBar(ctx: CommandContext): void;
}

const COMMAND_ARGUMENTS: CommandArgumentCompletion[] = [
  { value: "status", label: "status  — show current routing and connection state" },
  { value: "on", label: "on      — route all requests through AWS Bedrock" },
  { value: "off", label: "off     — switch back to Claude direct API" },
  { value: "health", label: "health  — check Claude API & AWS credentials" },
];

export function registerClauderockCommand(
  pi: CommandRegistrationAPI,
  { routingState, syncStatusBar }: ClauderockCommandDependencies,
): void {
  pi.registerCommand("clauderock", {
    description: "Claude ↔ Bedrock routing (status | on | off | health)",
    getArgumentCompletions: (prefix: string): CommandArgumentCompletion[] | null => {
      const filtered = COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const action = (args || "").trim().toLowerCase() || "status";

      if (action === "off") {
        clearCache();
        routingState.manualOff();
        syncStatusBar(ctx as CommandContext);
        ctx.ui.notify(
          `${ctx.ui.theme.fg("success", "✓ Switched to Claude direct")} — Bedrock fallback disabled`,
          "info",
        );
        return;
      }

      if (action === "on") {
        const reason = "manually forced via /clauderock on";
        routingState.manualOn(reason);
        writeCache(reason);
        syncStatusBar(ctx as CommandContext);
        ctx.ui.notify(
          `${ctx.ui.theme.fg("warning", "● Switched to Bedrock fallback")} — run ${ctx.ui.theme.fg("accent", "/clauderock off")} for Claude direct`,
          "info",
        );
        return;
      }

      if (action === "health") {
        ctx.ui.notify("Running Clauderock health checks…", "info");

        const health = await runClauderockHealthChecks();
        const lines = [
          formatClaudeApiHealthLine(ctx.ui.theme, health.claudeApi),
          ...formatAwsBedrockHealthLines(ctx.ui.theme, health.awsBedrock),
        ];

        const cached = readCache();
        const state = routingState.getPresentationState();
        const routeLine = formatRoutingHealthLine(ctx.ui.theme, state, {
          since: state.since ?? cached?.since ?? null,
          reason: state.reason ?? cached?.reason ?? null,
        });
        if (routeLine) {
          lines.push(routeLine);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const cached = readCache();
      const state = routingState.getPresentationState();
      const summary = formatRoutingSummary(ctx.ui.theme, state, {
        since: state.since ?? cached?.since ?? null,
        reason: state.reason ?? cached?.reason ?? null,
      });
      if (summary) {
        ctx.ui.notify(summary, "info");
      }
    },
  });
}

function formatClaudeApiHealthLine(theme: ThemeLike, result: ClaudeApiHealthResult): string {
  const label = theme.fg("accent", "Claude API");

  switch (result.code) {
    case "missing-credentials":
      return `${formatHealthStatus(theme, result.status)} ${label} — No credentials (run /login anthropic)`;
    case "token-expired":
      return `${formatHealthStatus(theme, result.status)} ${label} — OAuth token expired (run /login anthropic)`;
    case "quota-available": {
      const parts: string[] = [];
      if (typeof result.tokensRemaining === "number") {
        parts.push(`${result.tokensRemaining.toLocaleString()} tokens left`);
      }
      if (typeof result.requestsRemaining === "number") {
        parts.push(`${result.requestsRemaining.toLocaleString()} requests left`);
      }
      if (result.resetAt) {
        parts.push(`resets ${result.resetAt}`);
      }
      const detail = parts.length > 0 ? parts.join(", ") : "no usage data available";
      return `${formatHealthStatus(theme, result.status)} ${label} — Quota available (${detail})`;
    }
    case "quota-exhausted":
      return `${formatHealthStatus(theme, result.status)} ${label} — Quota exhausted (402 billing error)`;
    case "token-invalid":
      return `${formatHealthStatus(theme, result.status)} ${label} — Token invalid (run /login anthropic)`;
    case "rate-limited":
      return `${formatHealthStatus(theme, result.status)} ${label} — Rate limited${result.resetAt ? `, resets ${result.resetAt}` : ""}`;
    case "http-error":
      return `${formatHealthStatus(theme, result.status)} ${label} — HTTP ${result.httpStatus ?? "unknown"}${result.detail ? `: ${result.detail}` : ""}`;
    case "exception":
      return `${formatHealthStatus(theme, result.status)} ${label} — ${result.detail ?? "Unknown error"}`;
  }
}

function formatAwsBedrockHealthLines(theme: ThemeLike, result: AwsBedrockHealthResult): string[] {
  return result.entries.map((entry) => formatAwsBedrockHealthLine(theme, entry));
}

function formatAwsBedrockHealthLine(theme: ThemeLike, entry: AwsBedrockHealthEntry): string {
  const label = theme.fg("accent", "AWS Bedrock");

  switch (entry.source) {
    case "profile":
      if (entry.code === "credentials-valid") {
        return `${formatHealthStatus(theme, entry.status)} ${label} — Profile [${entry.profile}], Account: ${entry.account}`;
      }
      if (entry.code === "credentials-expired") {
        return `${formatHealthStatus(theme, entry.status)} ${label} — Profile [${entry.profile}] credentials expired`;
      }
      return `${formatHealthStatus(theme, entry.status)} ${label} — Profile [${entry.profile}] invalid`;

    case "env":
      if (entry.code === "credentials-valid") {
        return `${formatHealthStatus(theme, entry.status)} ${label} — Env vars, Account: ${entry.account}`;
      }
      return `${formatHealthStatus(theme, entry.status)} ${label} — Env vars set but credentials invalid`;

    case "cli":
      return `${formatHealthStatus(theme, entry.status)} ${label} — aws CLI not found (install awscli)`;

    case "summary":
      switch (entry.code) {
        case "no-credentials":
          return `${formatHealthStatus(theme, entry.status)} ${label} — No credentials configured`;
        case "no-valid-credentials":
          return `${formatHealthStatus(theme, entry.status)} ${label} — No valid credentials found`;
        case "exception":
          return `${formatHealthStatus(theme, entry.status)} ${label} — ${entry.detail ?? "Unknown error"}`;
      }
  }
}

function formatHealthStatus(theme: ThemeLike, status: ClaudeApiHealthResult["status"]): string {
  if (status === "ok") {
    return theme.fg("success", "✓");
  }

  if (status === "warning") {
    return theme.fg("warning", "!");
  }

  return theme.fg("error", "✗");
}
