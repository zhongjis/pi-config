/// <reference path="./clauderock-shims.d.ts" />
import {
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
  streamSimple,
  streamSimpleAnthropic,
} from "@mariozechner/pi-ai";
import { getPreferredAwsProfile } from "./aws";
import { writeCache } from "./cache";
import { isOauthRateLimitFallback, isQuotaError } from "./error-detection";
import { normalizeModelId, toBedrockModelId } from "./model-mapping";
import type { RoutingStateController } from "./routing-state";

export function createStreamWithFallback(routingState: RoutingStateController) {
  return function streamWithFallback(
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
      if (routingState.getPresentationState().fallbackActive) {
        if (bedrockId) {
          routingState.queueFallbackNotificationIfNeeded();
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

          const fallbackError = (event as any).error ?? event;
          const quotaError = isQuotaError(fallbackError);
          const rateLimitFallback = isOauthRateLimitFallback(fallbackError);

          if (
            event.type === "error" &&
            !hasResponseContent &&
            (quotaError || rateLimitFallback)
          ) {
            const reason = (event as any).error?.message ?? (event as any).errorMessage ?? "quota exhausted";
            routingState.activateFallback({
              source: "runtime",
              cause: quotaError ? "quota-exhausted" : "oauth-rate-limit",
              reason,
              queueNotification: "quota_exhausted",
            });
            writeCache(reason);

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
        const quotaError = isQuotaError(err);
        const rateLimitFallback = isOauthRateLimitFallback(err);

        if ((quotaError || rateLimitFallback) && !hasResponseContent) {
          const reason = err instanceof Error ? err.message : "quota exhausted";
          routingState.activateFallback({
            source: "runtime",
            cause: quotaError ? "quota-exhausted" : "oauth-rate-limit",
            reason,
            queueNotification: "quota_exhausted",
          });
          writeCache(reason);

          if (bedrockId) {
            await streamViaBedrock(model, bedrockId, context, options, stream);
            return;
          }
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
  };
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

  try {
    const bedrockStream = streamSimple(bedrockModel, context, {
      ...options,
      apiKey: undefined,
      profile,
      region,
    });
    for await (const event of bedrockStream) {
      // Rewrite model references so pi never sees the Bedrock model ID.
      // This prevents Bedrock IDs from leaking into pi state and breaking
      // subsequent requests (e.g., after a mode switch).
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
        `Claude API quota/rate-limit was exhausted.${suffix ? ` (${suffix})` : ""}`,
      ),
    });
    stream.end();
  }
}
