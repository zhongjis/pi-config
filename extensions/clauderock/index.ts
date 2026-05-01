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
  "claude-opus-4-7":           "us.anthropic.claude-opus-4-7",
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
    "cause" in err && (err as any).cause && typeof (err as any).cause === "object" && typeof (err as any).cause.message === "string"
      ? (err as any).cause.message
      : "",
  ];
  return parts.join(" ").toLowerCase();
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = getErrorText(err);

  if ("status" in err && (err as any).status === 402) return true;
  if ("statusCode" in err && (err as any).statusCode === 402) return true;

  return msg.includes("billing") || msg.includes("credit")
      || msg.includes("spend limit") || msg.includes("quota");
}

function isOauthRateLimitFallback(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = getErrorText(err);
  return ("status" in err && (err as any).status === 429)
      || ("statusCode" in err && (err as any).statusCode === 429)
      || ("error" in err && typeof (err as any).error?.status === "number" && (err as any).error.status === 429)
      || msg.includes("rate limit") || msg.includes("rate-limit")
      || msg.includes("rate_limit") || msg.includes("too many requests");
}

/** Extract actionable diagnostics from AWS SDK errors (which often have opaque messages like 'Unknown: UnknownError'). */
function formatBedrockError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as Record<string, any>;

  // Core message — may be useless ('Unknown: UnknownError')
  const msg = e.message ?? e.errorMessage ?? String(err);

  // AWS SDK v3 metadata: httpStatusCode, requestId, attempts
  const meta = e.$metadata as Record<string, any> | undefined;
  const httpStatus = meta?.httpStatusCode;
  const requestId = meta?.requestId;

  // Error classification from the SDK
  const name = e.name && e.name !== "Error" ? e.name : undefined;
  const code = e.Code ?? e.code;
  const fault = e.$fault;

  // Credential conflict detection (the most common cause of UnknownError)
  const hasProfile = !!process.env.AWS_PROFILE;
  const hasStaticCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  const credInfo = hasProfile && hasStaticCreds
    ? " [CONFLICT: both AWS_PROFILE and static creds set]"
    : hasProfile ? " [creds: AWS_PROFILE]"
    : hasStaticCreds ? " [creds: static env vars]"
    : " [creds: none detected]";

  const parts: string[] = [];
  if (name) parts.push(name);
  if (code && code !== name) parts.push(`code=${code}`);
  if (httpStatus) parts.push(`HTTP ${httpStatus}`);
  if (fault) parts.push(`fault=${fault}`);
  parts.push(msg);
  if (requestId) parts.push(`requestId=${requestId}`);
  parts.push(credInfo);

  return parts.join(" — ");
}

/**
 * Translate opaque Bedrock validation errors into actionable messages.
 * Returns null when the error isn't a known pattern.
 */
function humanizeBedrockValidation(msg: string): string | null {
  // "The text field in the ContentBlock object at messages.6.content.0 is blank"
  const blankText = msg.match(
    /text field in the ContentBlock object at messages\.(\d+)\.content\.(\d+) is blank/i,
  );
  if (blankText) {
    const msgIdx = blankText[1];
    const blockIdx = blankText[2];
    return (
      `Bedrock rejected the request: message ${msgIdx}, content block ${blockIdx} has blank text. ` +
      `This usually means an empty assistant reply or a file reference that resolved to empty content ` +
      `ended up in the conversation history. Try sending a new message or starting a new session.`
    );
  }

  // "The system list must contain at least one system element"
  if (/system list must contain at least one system element/i.test(msg)) {
    return "Bedrock rejected the request: system prompt is empty. This is a pi bug — please report it.";
  }

  // "The conversation must contain at least one message"
  if (/conversation must contain at least one message/i.test(msg)) {
    return "Bedrock rejected the request: no messages in conversation. This is a pi bug — please report it.";
  }

  return null;
}

/** Short, UI-safe error message — no credentials, requestId, or verbose diagnostics. */
function getUiErrorMessage(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as Record<string, any>;
  const msg = e.message ?? e.errorMessage ?? "Unknown error";

  // Try to humanize known validation errors first
  const humanized = humanizeBedrockValidation(msg);
  if (humanized) return humanized;

  const meta = e.$metadata as Record<string, any> | undefined;
  const httpStatus = meta?.httpStatusCode;
  const name = e.name && e.name !== "Error" ? e.name : undefined;
  const code = e.Code ?? e.code;
  const fault = e.$fault;
  const shortMsg = msg.length > 100 ? msg.slice(0, 97) + "..." : msg;
  const parts: string[] = ["Bedrock"];
  if (name) parts.push(name);
  if (code && code !== name) parts.push(`code=${code}`);
  if (httpStatus) parts.push(`(HTTP ${httpStatus})`);
  if (fault) parts.push(`fault=${fault}`);
  if (!httpStatus) parts.push(`— ${shortMsg}`);
  return parts.join(": ");
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

interface AwsProfileCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function readAwsProfileCredentials(profile: string): AwsProfileCredentials | null {
  try {
    const credsPath = join(process.env.HOME || "", ".aws", "credentials");
    const credsFile = readFileSync(credsPath, "utf-8");
    let currentSection: string | null = null;
    const fields: Record<string, string> = {};

    for (const rawLine of credsFile.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;

      const sectionMatch = line.match(/^\[(.+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1].trim();
        continue;
      }

      if (currentSection !== profile) continue;

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) continue;

      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();
      if (value) fields[key] = value;
    }

    if (!fields.aws_access_key_id || !fields.aws_secret_access_key) {
      return null;
    }

    return {
      accessKeyId: fields.aws_access_key_id,
      secretAccessKey: fields.aws_secret_access_key,
      sessionToken: fields.aws_session_token || undefined,
    };
  } catch {
    return null;
  }
}

function syncAwsCredentialsFromProfile(profile: string | undefined): boolean {
  const resolvedProfile = profile ?? "default";
  const credentials = readAwsProfileCredentials(resolvedProfile);
  if (!credentials) return false;

  process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;

  if (credentials.sessionToken) {
    process.env.AWS_SESSION_TOKEN = credentials.sessionToken;
  } else {
    delete process.env.AWS_SESSION_TOKEN;
  }

  // Clear AWS_PROFILE when static credentials are set to avoid the SDK
  // "Multiple credential sources detected" warning and UnknownError.
  delete process.env.AWS_PROFILE;

  return true;
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

function patchMessageModelId<T>(message: T, modelId: string): T {
  if (!message || typeof message !== "object" || !("model" in message)) return message;
  return { ...(message as Record<string, unknown>), model: modelId } as T;
}

function patchBedrockEventModelIds<T>(event: T, modelId: string): T {
  if (!event || typeof event !== "object") return event;

  const original = event as Record<string, unknown>;
  let patched: Record<string, unknown> | null = null;
  const ensurePatched = () => patched ??= { ...original };

  if (typeof original.model === "string") {
    ensurePatched().model = modelId;
  }

  for (const key of ["partial", "message", "error"] as const) {
    const next = patchMessageModelId(original[key], modelId);
    if (next !== original[key]) {
      ensurePatched()[key] = next;
    }
  }

  return (patched ?? original) as T;
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
        const anthropicStream = streamSimpleAnthropic(model, context, { ...options, maxRetries: 0 });
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
      const anthropicStream = streamSimpleAnthropic(model, context, { ...options, maxRetries: 0 });
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
          if (bedrockId) {
            fallbackActive = true;
            writeCache(((event as any).error?.message ?? (event as any).errorMessage ?? "quota exhausted"));
            pendingNotification = "quota_exhausted";
            // Push start immediately so UI exits "Working..." before Bedrock connects
            const hadStart = !!pendingStart;
            if (pendingStart) { stream.push(pendingStart); pendingStart = null; }
            await streamViaBedrock(model, bedrockId, context, options, stream, hadStart);
            return;
          }
          // No Bedrock mapping — forward error, don't activate fallback
          if (pendingStart) { stream.push(pendingStart); pendingStart = null; }
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
        // Push start immediately so UI exits "Working..." before Bedrock connects
        const hadStart = !!pendingStart;
        if (pendingStart) { stream.push(pendingStart); pendingStart = null; }
        await streamViaBedrock(model, bedrockId, context, options, stream, hadStart);
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
  startAlreadyPushed = false,
): Promise<void> {
  const profile = getPreferredAwsProfile();
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const bedrockModel: Model<any> = {
    ...originalModel,
    id: bedrockId,
    provider: "bedrock",
    api: "bedrock-converse-stream" as Api,
    // Do not preserve Anthropic's base URL when routing through Bedrock.
    // pi-ai 0.70 treats a non-empty baseUrl as the Bedrock endpoint; keeping
    // "https://api.anthropic.com" sends AWS-signed Bedrock requests there and
    // surfaces as an opaque "Unknown: UnknownError".
    baseUrl: "",
  };

  // Credential resolution priority:
  //  1. Sync static creds from profile file → use those (AWS_PROFILE cleared)
  //  2. Env already has AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY → use as-is
  //  3. Set AWS_PROFILE for SDK credential chain (SSO, credential_process, etc.)
  // Never set AWS_PROFILE when static creds exist — the SDK warns
  // "Multiple credential sources detected" and may fail with UnknownError.
  const synced = syncAwsCredentialsFromProfile(profile);
  const envHasCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

  // If static creds exist (synced from file or already in env), always clear
  // AWS_PROFILE to prevent dual-source conflict. Only set AWS_PROFILE as a
  // last resort when no static creds exist at all.
  if (envHasCreds) {
    delete process.env.AWS_PROFILE;
  } else if (profile && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = profile;
  }

  if (!process.env.AWS_REGION && region) {
    process.env.AWS_REGION = region;
  }

  // Only pass profile to streamSimple when no static creds exist — otherwise
  // the SDK may internally create a profile-based provider that conflicts with
  // the env-based static credentials, causing UnknownError.
  const effectiveProfile = envHasCreds ? undefined : profile;
  try {
    // Filter non-standard message roles (branchSummary, compactionSummary,
    // bashExecution, custom, etc.) — Bedrock Converse rejects unknown roles
    // with "Unknown message role" while Anthropic silently skips them.
    const filteredContext: Context = {
      ...context,
      messages: (context.messages ?? []).filter((m) =>
        m.role === "user" || m.role === "assistant" || m.role === "toolResult",
      ),
    };
    const bedrockStream = streamSimple(bedrockModel, filteredContext, {
      ...options,
      apiKey: undefined,
      headers: undefined,  // clear Anthropic auth headers — they'd override AWS SigV4
      profile: effectiveProfile,
      region,
    });
    let completionSeen = false;
    for await (const event of bedrockStream) {
      const patchedEvent = patchBedrockEventModelIds(event, originalModel.id);
      // Skip duplicate start event when caller already pushed one
      if (patchedEvent.type === "start" && startAlreadyPushed) continue;
      // Rewrite model references so pi never sees the Bedrock model ID.
      // This prevents Bedrock IDs from leaking into pi state and breaking
      // subsequent requests (e.g., after a mode switch).
      if (patchedEvent.type === "done" || patchedEvent.type === "error") {
        completionSeen = true;
      }
      if (patchedEvent.type === "error") {
        // Enrich opaque Bedrock error events with diagnostic details
        const errObj = (patchedEvent as any).error ?? patchedEvent;

        // Abort: pass through cleanly — no enrichment, no console.error
        if (
          (patchedEvent as any).reason === "aborted" ||
          errObj?.stopReason === "aborted" ||
          errObj?.errorMessage === "Request was aborted"
        ) {
          stream.push(patchedEvent);
        } else {
          // Dump raw error for diagnostics — helps trace opaque "Unknown: UnknownError"
          try {
            const keys = errObj && typeof errObj === "object" ? Object.keys(errObj) : [];
            console.error("[clauderock] Bedrock stream error event:", {
              type: errObj?.constructor?.name,
              keys,
              errorMessage: errObj?.errorMessage,
              message: errObj?.message,
              stopReason: errObj?.stopReason,
              name: errObj?.name,
              code: errObj?.Code ?? errObj?.code,
              $metadata: errObj?.$metadata,
              $fault: errObj?.$fault,
              api: errObj?.api,
              provider: errObj?.provider,
              model: errObj?.model,
            });
          } catch { /* ignore logging errors */ }
          const enriched = {
            ...patchedEvent,
            error: { ...(typeof errObj === "object" ? errObj : {}), message: getUiErrorMessage(errObj) },
          };
          stream.push(enriched);
        }
      } else {
        stream.push(patchedEvent);
      }
    }
    if (!completionSeen) {
      // Bedrock stream closed without emitting a done/error event — push an error
      // so finalResultPromise resolves instead of hanging forever.
      stream.push({ type: "error", error: new Error("Bedrock stream ended without a completion event") });
    }
    stream.end();
  } catch (bedrockErr) {
    // Abort: clean exit
    if (bedrockErr instanceof Error && bedrockErr.message === "Request was aborted") {
      stream.push({ type: "error", reason: "aborted", error: { stopReason: "aborted", errorMessage: "Request was aborted" } });
      stream.end();
      return;
    }
    // Dump raw thrown error for diagnostics
    try {
      console.error("[clauderock] Bedrock thrown error:", {
        type: bedrockErr?.constructor?.name,
        name: (bedrockErr as any)?.name,
        message: (bedrockErr as any)?.message,
        code: (bedrockErr as any)?.Code ?? (bedrockErr as any)?.code,
        $metadata: (bedrockErr as any)?.$metadata,
        $fault: (bedrockErr as any)?.$fault,
        stack: (bedrockErr as any)?.stack?.split("\n").slice(0, 5).join("\n"),
      });
    } catch { /* ignore logging errors */ }
    console.error(`[clauderock] ${formatBedrockError(bedrockErr)}`);
    stream.push({
      type: "error",
      error: new Error(
        `Clauderock fallback failed (Claude API quota/rate-limit was exhausted): ${getUiErrorMessage(bedrockErr)}`,
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
    description: "Claude ↔ Bedrock routing (status | on | off | health | test)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [
        { value: "status", label: "status  — show current routing and connection state" },
        { value: "on", label: "on      — route all requests through AWS Bedrock" },
        { value: "off", label: "off     — switch back to Claude direct API" },
        { value: "health", label: "health  — check Claude API & AWS credentials" },
        { value: "test", label: "test    — make a raw SDK ConverseStream call to diagnose failures" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const action = (args || "").trim().toLowerCase() || "status";

      if (action === "test") {
        ctx.ui.notify("Running raw Bedrock ConverseStream test…", "info");
        const t = ctx.ui.theme;
        try {
          // Resolve from pi-ai's context since jiti can't find it from extension dir
          const { createRequire } = await import("module");
          const piRequire = createRequire(require.resolve("@mariozechner/pi-ai"));
          const { BedrockRuntimeClient, ConverseStreamCommand } = piRequire("@aws-sdk/client-bedrock-runtime");
          const profile = getPreferredAwsProfile();
          const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
          const envHasCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

          // Build config same way pi-ai does
          const config: Record<string, any> = {};
          if (region) config.region = region;
          // Deliberately do NOT set profile when static creds exist
          if (!envHasCreds && profile) config.profile = profile;

          const testModelId = "us.anthropic.claude-opus-4-6-v1";
          ctx.ui.notify(`Config: ${JSON.stringify(config)} | Model: ${testModelId} | Creds: ${envHasCreds ? "static env" : profile ? "profile " + profile : "default chain"}`, "info");

          const client = new BedrockRuntimeClient(config);
          const cmd = new ConverseStreamCommand({
            modelId: testModelId,
            messages: [{ role: "user", content: [{ text: "hi" }] }],
            inferenceConfig: { maxTokens: 1 },
          });
          const res = await client.send(cmd);
          let gotContent = false;
          for await (const item of res.stream!) {
            if (item.contentBlockDelta) gotContent = true;
            if (item.messageStop) break;
          }
          if (gotContent) {
            ctx.ui.notify(`${t.fg("success", "✓")} Raw SDK ConverseStream succeeded — Bedrock is reachable`, "info");
          } else {
            ctx.ui.notify(`${t.fg("warning", "!")} Stream completed but no content received`, "warning");
          }

          // Now test through pi-ai's streamSimple
          ctx.ui.notify("Testing through pi-ai streamSimple…", "info");
          const testModel: Model<any> = {
            id: testModelId,
            provider: "bedrock",
            api: "bedrock-converse-stream" as Api,
            name: "test",
            maxTokens: 32000,
            baseUrl: "",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
          };
          const testCtx: Context = {
            systemPrompt: "Reply with one word.",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          };
          let payloadReached = false;
          const piStream = streamSimple(testModel, testCtx, {
            maxTokens: 1,
            profile: envHasCreds ? undefined : profile,
            region,
            onPayload: (payload: any) => {
              payloadReached = true;
              console.error("[clauderock test] onPayload reached, modelId:", payload?.modelId);
              return payload;
            },
          } as any);
          let piGotContent = false;
          let piError: string | null = null;
          for await (const event of piStream) {
            if (event.type === "done") piGotContent = true;
            if (event.type === "error") {
              const errObj = (event as any).error ?? event;
              piError = errObj?.errorMessage ?? errObj?.message ?? JSON.stringify(errObj);
              // Dump full error + try to get stack from original cause
              console.error("[clauderock test] pi-ai error:", piError);
              console.error("[clauderock test] payloadReached:", payloadReached);
              // Try to find stack in any nested error
              const possibleStack = errObj?.stack ?? errObj?.cause?.stack;
              if (possibleStack) console.error("[clauderock test] stack:", possibleStack);
              // Log all keys
              if (errObj && typeof errObj === "object") {
                console.error("[clauderock test] error keys:", Object.keys(errObj));
              }
            }
          }
          if (piGotContent && !piError) {
            ctx.ui.notify(`${t.fg("success", "✓")} pi-ai streamSimple succeeded — full pipeline works`, "info");
          } else if (piError) {
            ctx.ui.notify(`${t.fg("error", "✗")} pi-ai streamSimple failed: ${piError}`, "error");
          } else {
            ctx.ui.notify(`${t.fg("warning", "!")} pi-ai streamSimple returned no content or error`, "warning");
          }
        } catch (err) {
          const e = err as any;
          const detail = [
            e?.name, e?.message,
            e?.$metadata ? `HTTP ${e.$metadata.httpStatusCode}` : "",
            e?.Code ?? e?.code,
            e?.$fault,
          ].filter(Boolean).join(" | ");
          ctx.ui.notify(`${ctx.ui.theme.fg("error", "✗")} Raw SDK test failed: ${detail}`, "error");
          console.error("[clauderock test] Full error:", e);
        }
        return;
      }

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
