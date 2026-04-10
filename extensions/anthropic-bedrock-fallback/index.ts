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
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Model ID mapping
// ---------------------------------------------------------------------------

const ANTHROPIC_TO_BEDROCK: Record<string, string> = {
  "claude-sonnet-4-6":         "anthropic.claude-sonnet-4-6",
  "claude-opus-4-6":           "anthropic.claude-opus-4-6-v1",
  "claude-haiku-4-5":          "anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-4-5-20251001": "anthropic.claude-haiku-4-5-20251001-v1:0",
};

function toBedrockModelId(anthropicId: string): string | null {
  return ANTHROPIC_TO_BEDROCK[anthropicId] ?? null;
}

// ---------------------------------------------------------------------------
// Quota error detection
// ---------------------------------------------------------------------------

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // Check .status === 402 (Anthropic SDK APIStatusError)
  if ("status" in err && (err as any).status === 402) return true;
  // Check .errorMessage (AssistantMessage from stream error event)
  if ("errorMessage" in err && typeof (err as any).errorMessage === "string") {
    const msg = (err as any).errorMessage.toLowerCase();
    return msg.includes("billing") || msg.includes("credit")
        || msg.includes("spend limit") || msg.includes("quota");
  }
  // Check Error.message
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("billing") || msg.includes("credit")
        || msg.includes("spend limit") || msg.includes("quota");
  }
  return false;
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
  return join(getAgentDir(), "anthropic-fallback-state.json");
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

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let fallbackActive = false;
let pendingNotification: "quota_exhausted" | "using_cached_fallback" | null = null;
let sessionNotified = false;

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
    let hasContent = false;
    try {
      const anthropicStream = streamSimpleAnthropic(model, context, options);
      for await (const event of anthropicStream) {
        if (event.type === "start") {
          hasContent = true;
        }

        if (
          event.type === "error" &&
          !hasContent &&
          isQuotaError((event as any).error ?? event)
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
          stream.push(event);
          stream.end();
          return;
        }

        stream.push(event);
      }
      stream.end();
    } catch (err) {
      if (isQuotaError(err) && bedrockId && !hasContent) {
        fallbackActive = true;
        writeCache(
          (err instanceof Error ? err.message : "quota exhausted"),
        );
        pendingNotification = "quota_exhausted";
        await streamViaBedrock(model, bedrockId, context, options, stream);
        return;
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

  try {
    const bedrockStream = streamSimple(bedrockModel, context, {
      ...options,
      apiKey: undefined,
    });
    for await (const event of bedrockStream) {
      stream.push(event);
    }
    stream.end();
  } catch (bedrockErr) {
    stream.push({
      type: "error",
      error: new Error(
        `Bedrock fallback also failed: ${bedrockErr instanceof Error ? bedrockErr.message : String(bedrockErr)}. ` +
        `Original provider (Anthropic) quota was exhausted.`,
      ),
    });
    stream.end();
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // 1. Initialize fallback state from cache
  const cache = readCache();
  if (cache?.exhausted) {
    fallbackActive = true;
  }

  // 2. Session start — update status bar and reset per-session flag
  pi.on("session_start", async (_event, ctx) => {
    sessionNotified = false;
    if (fallbackActive) {
      ctx.ui.setStatus("provider-fallback", "🔶 Bedrock (fallback)");
    } else {
      ctx.ui.setStatus("provider-fallback", "🟢 Anthropic");
    }
  });

  // 3. Turn end — deliver queued notifications
  pi.on("turn_end", async (_event, ctx) => {
    if (pendingNotification === "quota_exhausted") {
      ctx.ui.notify(
        "⚠️ Anthropic quota exhausted — switched to Bedrock",
        "warning",
      );
      ctx.ui.setStatus("provider-fallback", "🔶 Bedrock (fallback)");
      sessionNotified = true;
      pendingNotification = null;
    } else if (pendingNotification === "using_cached_fallback") {
      ctx.ui.notify(
        "ℹ️ Using Bedrock (Anthropic quota previously exhausted). /fallback reset to retry.",
        "info",
      );
      sessionNotified = true;
      pendingNotification = null;
    }
  });

  // 4. /fallback command
  pi.registerCommand("fallback", {
    description: "Manage Anthropic ↔ Bedrock fallback (status | reset | bedrock)",
    handler: async (args, ctx) => {
      const action = (args || "").trim().toLowerCase() || "status";

      if (action === "reset") {
        clearCache();
        fallbackActive = false;
        sessionNotified = false;
        ctx.ui.setStatus("provider-fallback", "🟢 Anthropic");
        ctx.ui.notify("✅ Fallback cleared — next request will use Anthropic", "info");
        return;
      }

      if (action === "bedrock") {
        fallbackActive = true;
        writeCache("manually forced via /fallback bedrock");
        ctx.ui.setStatus("provider-fallback", "🔶 Bedrock (forced)");
        ctx.ui.notify("🔶 Forced Bedrock mode — use /fallback reset to return to Anthropic", "info");
        return;
      }

      // status (default)
      const cached = readCache();
      if (fallbackActive) {
        ctx.ui.notify(
          `🔶 Bedrock fallback ACTIVE since ${cached?.since ?? "this session"}` +
          (cached?.reason ? ` — ${cached.reason}` : ""),
          "info",
        );
      } else {
        ctx.ui.notify("🟢 Anthropic is the active provider", "info");
      }
    },
  });

  // 5. Override anthropic provider
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: streamWithFallback,
  });
}
