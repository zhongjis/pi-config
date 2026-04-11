/// <reference path="./clauderock-shims.d.ts" />
import { readCache } from "./cache";
import { registerClauderockCommand } from "./commands";
import { normalizeModelId, toBedrockModelId } from "./model-mapping";
import { createRoutingStateController } from "./routing-state";
import { formatQueuedNotification, formatStatusBar } from "./status-presentation";
import { createStreamWithFallback } from "./stream-routing";

interface RoutingModelLike {
  id?: string;
  provider?: string;
}

interface ClauderockExtensionAPI {
  on(event: string, handler: (event: unknown, ctx: any) => Promise<void>): void;
  registerProvider(name: string, definition: { api: string; streamSimple: ReturnType<typeof createStreamWithFallback> }): void;
  registerCommand(
    name: string,
    definition: {
      description: string;
      getArgumentCompletions(prefix: string): { value: string; label: string }[] | null;
      handler(args: string, ctx: any): Promise<void>;
    },
  ): void;
}

function getRoutingModelState(model: RoutingModelLike | null | undefined) {
  const normalizedId = typeof model?.id === "string" ? normalizeModelId(model.id) : undefined;
  return {
    provider: model?.provider,
    modelId: normalizedId,
    hasFallbackTarget: !!(normalizedId && toBedrockModelId(normalizedId)),
  };
}

const routingState = createRoutingStateController();

interface StatusBarContext {
  ui: {
    notify?(message: string, level: "info" | "warning"): void;
    setStatus(key: string, text: string | undefined): void;
    theme: { fg(color: string, text: string): string };
  };
  model?: RoutingModelLike | null;
}

function syncStatusBar(ctx: StatusBarContext): void {
  ctx.ui.setStatus("clauderock", formatStatusBar(ctx.ui.theme, routingState.getPresentationState()));
}

function handleSessionStart(ctx: StatusBarContext): void {
  routingState.beginSession(getRoutingModelState(ctx.model));
  syncStatusBar(ctx);
}

function handleModelSelect(event: unknown, ctx: StatusBarContext): void {
  routingState.updateModel(getRoutingModelState((event as { model?: RoutingModelLike } | null)?.model));
  syncStatusBar(ctx);
}

function handleTurnEnd(ctx: StatusBarContext): void {
  const pendingNotification = routingState.popQueuedNotification();
  if (pendingNotification && ctx.ui.notify) {
    const presentation = formatQueuedNotification(
      ctx.ui.theme,
      pendingNotification,
      routingState.getPresentationState(),
    );

    ctx.ui.notify(presentation.message, presentation.level);
    routingState.markSessionNotified();
  }

  syncStatusBar(ctx);
}

export default function (pi: ClauderockExtensionAPI) {
  routingState.initializeFromCache(readCache());

  pi.on("session_start", async (_event, ctx) => {
    handleSessionStart(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    handleModelSelect(event, ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    handleTurnEnd(ctx);
  });

  registerClauderockCommand(pi, { routingState, syncStatusBar });

  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: createStreamWithFallback(routingState),
  });
}
