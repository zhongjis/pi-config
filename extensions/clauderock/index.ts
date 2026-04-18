import {
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
  streamSimple,
  streamSimpleAnthropic,
} from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Model ID mapping
// ---------------------------------------------------------------------------

const ANTHROPIC_TO_BEDROCK: Record<string, string> = {
  "claude-sonnet-4-6":         "us.anthropic.claude-sonnet-4-6",
  "claude-opus-4-6":           "us.anthropic.claude-opus-4-6-v1",
  "claude-haiku-4-5":          "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-4-5-20251001": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
};

// Reverse map: Bedrock ID (with and without region prefix) → Anthropic ID
const BEDROCK_TO_ANTHROPIC: Record<string, string> = {};
for (const [anthropicId, bedrockId] of Object.entries(ANTHROPIC_TO_BEDROCK)) {
  BEDROCK_TO_ANTHROPIC[bedrockId] = anthropicId;
  // Also map the non-region-prefixed variant (e.g., "anthropic.claude-opus-4-6-v1")
  const noRegion = bedrockId.replace(/^us\./, "");
  if (noRegion !== bedrockId) {
    BEDROCK_TO_ANTHROPIC[noRegion] = anthropicId;
  }
}

function toBedrockModelId(anthropicId: string): string | null {
  return ANTHROPIC_TO_BEDROCK[anthropicId] ?? null;
}

/** If a Bedrock-style model ID leaked into pi state, recover the Anthropic ID. */
function normalizeModelId(id: string): string {
  return BEDROCK_TO_ANTHROPIC[id] ?? id;
}

// ---------------------------------------------------------------------------
// Quota error detection
// ---------------------------------------------------------------------------

function getErrorText(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const parts = [
    "errorMessage" in err && typeof (err as any).errorMessage === "string" ? (err as any).errorMessage : "",
    "message" in err && typeof (err as any).message === "string" ? (err as any).message : "",
    "error" in err && (err as any).error && typeof (err as any).error === "object" && typeof (err as any).error.errorMessage === "string"
      ? (err as any).error.errorMessage
      : "",
    "error" in err && (err as any).error && typeof (err as any).error === "object" && typeof (err as any).error.message === "string"
      ? (err as any).error.message
      : "",
  ];
  return parts.join(" ").toLowerCase();
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = getErrorText(err);

  if ("status" in err && (err as any).status === 402) return true;

  return msg.includes("billing") || msg.includes("credit")
      || msg.includes("spend limit") || msg.includes("quota");
}

function isOauthRateLimitFallback(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = getErrorText(err);
  return ("status" in err && (err as any).status === 429)
      || msg.includes("rate limit") || msg.includes("too many requests");
}

// ---------------------------------------------------------------------------
// Cross-session cache
// ---------------------------------------------------------------------------

interface FallbackCache {
  exhausted: boolean;
  since: string;
  reason: string;
}

function getCachePath(): string {
  return join(getAgentDir(), "clauderock-state.json");
}

function readCache(): FallbackCache | null {
  try {
    const raw = readFileSync(getCachePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.exhausted) {
      return parsed as FallbackCache;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(reason: string): void {
  const data: FallbackCache = {
    exhausted: true,
    since: new Date().toISOString(),
    reason,
  };
  writeFileSync(getCachePath(), JSON.stringify(data, null, 2));
}

function clearCache(): void {
  try {
    unlinkSync(getCachePath());
  } catch {
    // file may not exist — ignore
  }
}

function getAwsProfiles(): string[] {
  try {
    const credsPath = join(process.env.HOME || "", ".aws", "credentials");
    const credsFile = readFileSync(credsPath, "utf-8");
    return [...credsFile.matchAll(/^\[(.+)\]$/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

function getPreferredAwsProfile(): string | undefined {
  const envProfile = process.env.AWS_PROFILE?.trim();
  if (envProfile) return envProfile;

  const profiles = getAwsProfiles();
  if (profiles.includes("default")) return undefined;
  if (profiles.length === 1) return profiles[0];
  return profiles[0];
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let fallbackActive = false;
let pendingNotification: "quota_exhausted" | "using_cached_fallback" | null = null;
let sessionNotified = false;
let agentStarted = false; // true only after agent_start fires; guards against history-replay message_start

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

let isAnthropicProvider = false;

function updateStatusBar(ctx: { ui: { setStatus(key: string, text: string | undefined): void; theme: { fg(color: string, text: string): string } } }): void {
  if (!isAnthropicProvider || !fallbackActive) {
    ctx.ui.setStatus("clauderock", undefined);
    return;
  }
  const t = ctx.ui.theme;
  ctx.ui.setStatus("clauderock", t.fg("warning", "● Clauderock"));
}

// ---------------------------------------------------------------------------
// Stream wrapper
// ---------------------------------------------------------------------------

function streamWithFallback(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();

  (async () => {
    // Normalize model ID — if a Bedrock-style ID leaked into pi state
    // (e.g., after a mode switch), recover the clean Anthropic ID.
    const normalizedId = normalizeModelId(model.id);
    if (normalizedId !== model.id) {
      model = { ...model, id: normalizedId };
    }
    const bedrockId = toBedrockModelId(model.id);

    // Fast path: fallback already active
    if (fallbackActive) {
      if (bedrockId) {
        if (!sessionNotified) {
          pendingNotification = "using_cached_fallback";
        }
        await streamViaBedrock(model, bedrockId, context, options, stream);
        return;
      }
      // No Bedrock mapping — let Anthropic fail naturally
      try {
        const anthropicStream = streamSimpleAnthropic(model, context, options);
        for await (const event of anthropicStream) {
          stream.push(event);
        }
        stream.end();
      } catch (err) {
        stream.push({ type: "error", error: err });
        stream.end();
      }
      return;
    }

    // Normal path: try Anthropic first
    let hasResponseContent = false;
    let pendingStart: any = null;
    try {
      const anthropicStream = streamSimpleAnthropic(model, context, options);
      for await (const event of anthropicStream) {
        if (event.type === "start") {
          pendingStart = event;
          continue;
        }

        if (
          event.type === "error" &&
          !hasResponseContent &&
          (isQuotaError((event as any).error ?? event) || isOauthRateLimitFallback((event as any).error ?? event))
        ) {
          fallbackActive = true;
          writeCache(
            ((event as any).error?.message ?? (event as any).errorMessage ?? "quota exhausted"),
          );
          pendingNotification = "quota_exhausted";

          if (bedrockId) {
            await streamViaBedrock(model, bedrockId, context, options, stream);
            return;
          }
          // No mapping — forward the error as-is
          if (pendingStart) {
            stream.push(pendingStart);
            pendingStart = null;
          }
          stream.push(event);
          stream.end();
          return;
        }

        if (pendingStart) {
          stream.push(pendingStart);
          pendingStart = null;
        }

        hasResponseContent = true;
        stream.push(event);
      }
      if (pendingStart) {
        stream.push(pendingStart);
      }
      stream.end();
    } catch (err) {
      if ((isQuotaError(err) || isOauthRateLimitFallback(err)) && bedrockId && !hasResponseContent) {
        fallbackActive = true;
        writeCache(
          (err instanceof Error ? err.message : "quota exhausted"),
        );
        pendingNotification = "quota_exhausted";
        await streamViaBedrock(model, bedrockId, context, options, stream);
        return;
      }
      if (pendingStart) {
        stream.push(pendingStart);
      }
      stream.push({ type: "error", error: err });
      stream.end();
    }
  })().catch((fatal) => {
    stream.push({ type: "error", error: fatal });
    stream.end();
  });

  return stream;
}

async function streamViaBedrock(
  originalModel: Model<any>,
  bedrockId: string,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<void> {
  const bedrockModel: Model<any> = {
    ...originalModel,
    id: bedrockId,
    provider: "bedrock",
    api: "bedrock-converse-stream" as Api,
  };

  const profile = getPreferredAwsProfile();
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

  if (profile && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = profile;
  }
  if (region && !process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
    process.env.AWS_REGION = region;
  }

  try {
    const bedrockStream = streamSimple(bedrockModel, context, {
      ...options,
      apiKey: undefined,
      headers: undefined,  // clear Anthropic auth headers — they'd override AWS SigV4
      reasoning: undefined, // Bedrock Converse doesn't accept a freeform reasoning param
      profile,
      region,
    });
    let completionSeen = false;
    for await (const event of bedrockStream) {
      // Rewrite model references so pi never sees the Bedrock model ID.
      // This prevents Bedrock IDs from leaking into pi state and breaking
      // subsequent requests (e.g., after a mode switch).
      if (event.type === "done" || event.type === "error") {
        completionSeen = true;
      }
      if (event.type === "start") {
        const patched: any = { ...event };
        if (patched.model) patched.model = originalModel.id;
        if (patched.message?.model) {
          patched.message = { ...patched.message, model: originalModel.id };
        }
        stream.push(patched);
      } else {
        stream.push(event);
      }
    }
    if (!completionSeen) {
      // Bedrock stream closed without emitting a done/error event — push an error
      // so finalResultPromise resolves instead of hanging forever.
      stream.push({ type: "error", error: new Error("Bedrock stream ended without a completion event") });
    }
    stream.end();
  } catch (bedrockErr) {
    const suffix = [
      profile ? `AWS profile: ${profile}` : "",
      region ? `region: ${region}` : "",
    ].filter(Boolean).join(", ");
    stream.push({
      type: "error",
      error: new Error(
        `Clauderock fallback failed: ${bedrockErr instanceof Error ? bedrockErr.message : String(bedrockErr)}. ` +
        `Claude API quota/rate-limit was exhausted.${suffix ? ` (${suffix})` : ""}` ,
      ),
    });
    stream.end();
  }
}

// ---------------------------------------------------------------------------
// Extension entry point

export default function (pi: ExtensionAPI) {
  // 1. Initialize fallback state from cache
  const cache = readCache();
  if (cache?.exhausted) {
    fallbackActive = true;
  }

  // 2. Session start — update status bar and reset per-session flags
  pi.on("session_start", async (_event, ctx) => {
    sessionNotified = false;
    agentStarted = false;
    isAnthropicProvider = ctx.model?.provider === "anthropic";
    updateStatusBar(ctx);
  });

  // 2b. Track model provider changes — show status only for Anthropic models
  pi.on("model_select", async (event, ctx) => {
    isAnthropicProvider = (event as any).model?.provider === "anthropic";
    updateStatusBar(ctx);
  });

  // 2c. agent_start — marks that a real agent loop is running (not history replay)
  pi.on("agent_start", async (_event, _ctx) => {
    agentStarted = true;
  });

  // 3. message_start (user role, live turn only) — fires when user message enters the view.
  //    Guard with agentStarted to skip history-replay messages on session load.
  pi.on("message_start", async (event, ctx) => {
    if ((event as any).message?.role !== "user") return;
    if (!agentStarted) return;
    if (fallbackActive && !sessionNotified && isAnthropicProvider) {
      ctx.ui.notify(
        "Using Clauderock — Claude API was previously rate-limited. Run " + ctx.ui.theme.fg("accent", "/clauderock off") + " to retry direct API.",
        "info",
      );
      updateStatusBar(ctx);
      sessionNotified = true;
    }
  });

  // 3b. Turn end — deliver quota_exhausted notification (fires after Bedrock stream completes)
  pi.on("turn_end", async (_event, ctx) => {
    if (pendingNotification === "quota_exhausted") {
      ctx.ui.notify(
        ctx.ui.theme.fg("warning", "⚠ Claude rate limit hit") + " — switching to Clauderock",
        "warning",
      );
      updateStatusBar(ctx);
      sessionNotified = true;
      pendingNotification = null;
    } else if (pendingNotification === "using_cached_fallback") {
      // Fallback: if before_agent_start somehow missed it, deliver here
      ctx.ui.notify(
        "Using Clauderock — Claude API was previously rate-limited. Run " + ctx.ui.theme.fg("accent", "/clauderock off") + " to retry direct API.",
        "info",
      );
      updateStatusBar(ctx);
      sessionNotified = true;
      pendingNotification = null;
    }
  });

  // 4. /clauderock command
  pi.registerCommand("clauderock", {
    description: "Claude ↔ Bedrock routing (status | on | off | health)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [
        { value: "status", label: "status  — show current routing and connection state" },
        { value: "on", label: "on      — route all requests through AWS Bedrock" },
        { value: "off", label: "off     — switch back to Claude direct API" },
        { value: "health", label: "health  — check Claude API & AWS credentials" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const action = (args || "").trim().toLowerCase() || "status";

      if (action === "off") {
        clearCache();
        fallbackActive = false;
        sessionNotified = false;
        updateStatusBar(ctx);
        ctx.ui.notify(ctx.ui.theme.fg("success", "✓ Switched to Claude direct API") + " — Clauderock disabled", "info");
        return;
      }

      if (action === "on") {
        fallbackActive = true;
        writeCache("manually forced via /clauderock on");
        updateStatusBar(ctx);
        ctx.ui.notify(ctx.ui.theme.fg("warning", "● Switched to Clauderock") + " — run " + ctx.ui.theme.fg("accent", "/clauderock off") + " for direct API", "info");
        return;
      }

      if (action === "health") {
        ctx.ui.notify("Running Clauderock health checks\u2026", "info");
        const t = ctx.ui.theme;
        const lines: string[] = [];

        // --- Claude API check ---
        try {
          const authPath = join(getAgentDir(), "auth.json");
          const auth = JSON.parse(readFileSync(authPath, "utf-8"));
          const cred = auth.anthropic;

          if (!cred?.access) {
            lines.push(`${t.fg("error", "✗")} ${t.fg("accent", "Claude API")} \u2014 No credentials (run /login anthropic)`);
          } else if (cred.expires && Date.now() > cred.expires) {
            lines.push(`${t.fg("warning", "!")} ${t.fg("accent", "Claude API")} \u2014 OAuth token expired (run /login anthropic)`);
          } else {
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

            const tokensLeft = resp.headers.get("anthropic-ratelimit-tokens-remaining");
            const tokensReset = resp.headers.get("anthropic-ratelimit-tokens-reset");
            const requestsLeft = resp.headers.get("anthropic-ratelimit-requests-remaining");

            if (resp.ok) {
              const parts: string[] = [];
              if (tokensLeft) parts.push(`${Number(tokensLeft).toLocaleString()} tokens left`);
              if (requestsLeft) parts.push(`${Number(requestsLeft).toLocaleString()} requests left`);
              if (tokensReset) parts.push(`resets ${tokensReset}`);
              const detail = parts.length ? parts.join(", ") : "no usage data available";
              lines.push(`${t.fg("success", "✓")} ${t.fg("accent", "Claude API")} \u2014 Quota available (${detail})`);
            } else if (resp.status === 402) {
              lines.push(`${t.fg("error", "✗")} ${t.fg("accent", "Claude API")} \u2014 Quota exhausted (402 billing error)`);
            } else if (resp.status === 401) {
              lines.push(`${t.fg("warning", "!")} ${t.fg("accent", "Claude API")} \u2014 Token invalid (run /login anthropic)`);
            } else if (resp.status === 429) {
              const resetInfo = tokensReset ? `, resets ${tokensReset}` : "";
              lines.push(`${t.fg("warning", "!")} ${t.fg("accent", "Claude API")} \u2014 Rate limited${resetInfo}`);
            } else {
              const body = await resp.text().catch(() => "");
              lines.push(`${t.fg("warning", "!")} ${t.fg("accent", "Claude API")} \u2014 HTTP ${resp.status}${body ? `: ${body.slice(0, 100)}` : ""}`);
            }
          }
        } catch (err) {
          lines.push(`${t.fg("error", "✗")} ${t.fg("accent", "Claude API")} \u2014 ${err instanceof Error ? err.message : String(err)}`);
        }

        // --- AWS / Bedrock check ---
        try {
          try {
            execSync("which aws", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
          } catch {
            lines.push(`${t.fg("error", "✗")} ${t.fg("accent", "AWS Bedrock")} \u2014 aws CLI not found (install awscli)`);
            throw new Error("__skip__");
          }

          let profiles: string[] = [];
          try {
            const credsPath = join(process.env.HOME || "", ".aws", "credentials");
            const credsFile = readFileSync(credsPath, "utf-8");
            profiles = [...credsFile.matchAll(/^\[(.+)\]$/gm)].map(m => m[1]);
          } catch {
            // no credentials file
          }

          const envProfile = process.env.AWS_PROFILE;
          const hasEnvKeys = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

          const profilesToTry = ["default", ...profiles.filter(p => p !== "default")];
          if (envProfile && !profilesToTry.includes(envProfile)) {
            profilesToTry.unshift(envProfile);
          }

          let anyValid = false;
          for (const profile of profilesToTry) {
            try {
              const profileArg = profile === "default" && !profiles.includes("default") ? "" : `--profile ${profile}`;
              const output = execSync(
                `aws sts get-caller-identity --output json ${profileArg}`.trim(),
                { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
              );
              const identity = JSON.parse(output);
              lines.push(`${t.fg("success", "✓")} ${t.fg("accent", "AWS Bedrock")} \u2014 Profile [${profile}], Account: ${identity.Account}`);
              anyValid = true;
            } catch (profileErr) {
              const msg = profileErr instanceof Error ? profileErr.message : String(profileErr);
              if (msg.includes("expired")) {
                lines.push(`${t.fg("warning", "!")} ${t.fg("accent", "AWS Bedrock")} \u2014 Profile [${profile}] credentials expired`);
              } else if (msg.includes("Unable to locate")) {
                // skip non-existent default profile silently
              } else {
                lines.push(`${t.fg("error", "✗")} ${t.fg("accent", "AWS Bedrock")} \u2014 Profile [${profile}] invalid`);
              }
            }
          }

          if (hasEnvKeys) {
            try {
              const output = execSync(
                "aws sts get-caller-identity --output json",
                { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
                  env: { ...process.env } },
              );
              const identity = JSON.parse(output);
              lines.push(`${t.fg("success", "✓")} ${t.fg("accent", "AWS Bedrock")} \u2014 Env vars, Account: ${identity.Account}`);
              anyValid = true;
            } catch {
              lines.push(`${t.fg("warning", "!")} ${t.fg("accent", "AWS Bedrock")} \u2014 Env vars set but credentials invalid`);
            }
          }

          if (!anyValid && profiles.length === 0 && !hasEnvKeys) {
            lines.push(`${t.fg("error", "✗")} ${t.fg("accent", "AWS Bedrock")} \u2014 No credentials configured`);
          } else if (!anyValid) {
            lines.push(`${t.fg("error", "✗")} ${t.fg("accent", "AWS Bedrock")} \u2014 No valid credentials found`);
          }
        } catch (err) {
          if (!(err instanceof Error && err.message === "__skip__")) {
            lines.push(`${t.fg("error", "✗")} ${t.fg("accent", "AWS Bedrock")} \u2014 ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // --- Clauderock state ---
        const cached = readCache();
        if (fallbackActive) {
          lines.push(`${t.fg("warning", "●")} ${t.fg("accent", "Clauderock")} \u2014 Active since ${cached?.since ?? "this session"}`);
        } else {
          lines.push(`${t.fg("dim", "○")} ${t.fg("accent", "Clauderock")} \u2014 Standby (using Claude direct API)`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // status (default)
      const cached = readCache();
      if (fallbackActive) {
        ctx.ui.notify(
          ctx.ui.theme.fg("warning", "● Clauderock") + ` active since ${cached?.since ?? "this session"}` +
          (cached?.reason ? ` \u2014 ${cached.reason}` : ""),
          "info",
        );
      } else {
        ctx.ui.notify(ctx.ui.theme.fg("success", "● Claude") + " direct API active. Clauderock on standby.", "info");
      }
    },
  });

  // 5. Override anthropic provider — quota/rate-limit fallback to Bedrock
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: streamWithFallback,
  });
}
