/// <reference path="./clauderock-shims.d.ts" />
declare const process: { env: Record<string, string | undefined> };
declare function require(id: string): any;

const { getAgentDir } = require("@mariozechner/pi-coding-agent") as { getAgentDir: () => string };
const { execSync } = require("child_process") as { execSync: (...args: any[]) => string };
const { readFileSync } = require("fs") as { readFileSync: (...args: any[]) => string };
const { join } = require("path") as { join: (...parts: string[]) => string };

import { getAwsProfiles, getAwsProfilesToTry } from "./aws";

export type ProbeStatus = "ok" | "warning" | "error";

export interface ClaudeApiHealthResult {
  service: "claude-api";
  status: ProbeStatus;
  code:
    | "missing-credentials"
    | "token-expired"
    | "quota-available"
    | "quota-exhausted"
    | "token-invalid"
    | "rate-limited"
    | "http-error"
    | "exception";
  detail?: string | null;
  httpStatus?: number;
  tokensRemaining?: number | null;
  requestsRemaining?: number | null;
  resetAt?: string | null;
}

export interface AwsProfileHealthResult {
  source: "profile";
  profile: string;
  status: ProbeStatus;
  code: "credentials-valid" | "credentials-expired" | "credentials-invalid";
  account?: string;
}

export interface AwsEnvHealthResult {
  source: "env";
  status: ProbeStatus;
  code: "credentials-valid" | "credentials-invalid";
  account?: string;
}

export interface AwsCliHealthResult {
  source: "cli";
  status: ProbeStatus;
  code: "cli-missing";
  detail?: string | null;
}

export interface AwsSummaryHealthResult {
  source: "summary";
  status: ProbeStatus;
  code: "no-credentials" | "no-valid-credentials" | "exception";
  detail?: string | null;
}

export type AwsBedrockHealthEntry = AwsProfileHealthResult | AwsEnvHealthResult | AwsCliHealthResult | AwsSummaryHealthResult;

export interface AwsBedrockHealthResult {
  service: "aws-bedrock";
  status: ProbeStatus;
  profiles: string[];
  hasEnvKeys: boolean;
  entries: AwsBedrockHealthEntry[];
}

export interface ClauderockHealthCheckResult {
  claudeApi: ClaudeApiHealthResult;
  awsBedrock: AwsBedrockHealthResult;
}

export async function runClauderockHealthChecks(): Promise<ClauderockHealthCheckResult> {
  const [claudeApi, awsBedrock] = await Promise.all([
    probeClaudeApi(),
    Promise.resolve(probeAwsBedrock()),
  ]);

  return { claudeApi, awsBedrock };
}

async function probeClaudeApi(): Promise<ClaudeApiHealthResult> {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    const cred = auth.anthropic;

    if (!cred?.access) {
      return {
        service: "claude-api",
        status: "error",
        code: "missing-credentials",
      };
    }

    if (cred.expires && Date.now() > cred.expires) {
      return {
        service: "claude-api",
        status: "warning",
        code: "token-expired",
      };
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": cred.access,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    });

    const tokensRemaining = parseNullableNumber(resp.headers.get("anthropic-ratelimit-tokens-remaining"));
    const requestsRemaining = parseNullableNumber(resp.headers.get("anthropic-ratelimit-requests-remaining"));
    const resetAt = resp.headers.get("anthropic-ratelimit-tokens-reset");

    if (resp.ok) {
      return {
        service: "claude-api",
        status: "ok",
        code: "quota-available",
        tokensRemaining,
        requestsRemaining,
        resetAt,
      };
    }

    if (resp.status === 402) {
      return {
        service: "claude-api",
        status: "error",
        code: "quota-exhausted",
        httpStatus: resp.status,
      };
    }

    if (resp.status === 401) {
      return {
        service: "claude-api",
        status: "warning",
        code: "token-invalid",
        httpStatus: resp.status,
      };
    }

    if (resp.status === 429) {
      return {
        service: "claude-api",
        status: "warning",
        code: "rate-limited",
        httpStatus: resp.status,
        resetAt,
      };
    }

    const body = await resp.text().catch(() => "");
    return {
      service: "claude-api",
      status: "warning",
      code: "http-error",
      httpStatus: resp.status,
      detail: body ? body.slice(0, 100) : null,
    };
  } catch (error) {
    return {
      service: "claude-api",
      status: "error",
      code: "exception",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function probeAwsBedrock(): AwsBedrockHealthResult {
  const profiles = getAwsProfiles();
  const hasEnvKeys = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  const entries: AwsBedrockHealthEntry[] = [];

  try {
    try {
      execSync("which aws", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      entries.push({
        source: "cli",
        status: "error",
        code: "cli-missing",
      });
      return {
        service: "aws-bedrock",
        status: "error",
        profiles,
        hasEnvKeys,
        entries,
      };
    }

    let anyValid = false;

    for (const profile of getAwsProfilesToTry(profiles)) {
      try {
        const profileArg = profile === "default" && !profiles.includes("default") ? "" : `--profile ${profile}`;
        const output = execSync(
          `aws sts get-caller-identity --output json ${profileArg}`.trim(),
          { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
        );
        const identity = JSON.parse(output);
        entries.push({
          source: "profile",
          profile,
          status: "ok",
          code: "credentials-valid",
          account: identity.Account,
        });
        anyValid = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("expired")) {
          entries.push({
            source: "profile",
            profile,
            status: "warning",
            code: "credentials-expired",
          });
        } else if (message.includes("Unable to locate")) {
          // Skip non-existent default profile silently.
        } else {
          entries.push({
            source: "profile",
            profile,
            status: "error",
            code: "credentials-invalid",
          });
        }
      }
    }

    if (hasEnvKeys) {
      try {
        const output = execSync(
          "aws sts get-caller-identity --output json",
          {
            encoding: "utf-8",
            timeout: 10000,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
          },
        );
        const identity = JSON.parse(output);
        entries.push({
          source: "env",
          status: "ok",
          code: "credentials-valid",
          account: identity.Account,
        });
        anyValid = true;
      } catch {
        entries.push({
          source: "env",
          status: "warning",
          code: "credentials-invalid",
        });
      }
    }

    if (!anyValid && profiles.length === 0 && !hasEnvKeys) {
      entries.push({
        source: "summary",
        status: "error",
        code: "no-credentials",
      });
    } else if (!anyValid) {
      entries.push({
        source: "summary",
        status: "error",
        code: "no-valid-credentials",
      });
    }
  } catch (error) {
    entries.push({
      source: "summary",
      status: "error",
      code: "exception",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    service: "aws-bedrock",
    status: getAggregateStatus(entries),
    profiles,
    hasEnvKeys,
    entries,
  };
}

function parseNullableNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAggregateStatus(entries: AwsBedrockHealthEntry[]): ProbeStatus {
  if (entries.some((entry) => entry.status === "error")) {
    return "error";
  }

  if (entries.some((entry) => entry.status === "warning")) {
    return "warning";
  }

  return "ok";
}
