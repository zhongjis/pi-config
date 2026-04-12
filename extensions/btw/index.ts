import {
  DynamicBorder,
  buildSessionContext,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { complete, type Message } from "@mariozechner/pi-ai";
import { Container, Markdown, Spacer, Text, matchesKey, type TUI } from "@mariozechner/pi-tui";

function normalizeReasoningLevel(level: string): string {
  return level === "off" ? "none" : level;
}

const BTW_WIDGET_KEY = "btw";
const BTW_SYSTEM_PROMPT = [
  "You are answering a short side question about the user's current session.",
  "Use the session messages as context only.",
  "Answer directly and concisely.",
  "Do not ask follow-up questions unless absolutely necessary.",
  "Do not assume the side answer changes the main thread unless the user explicitly says so.",
].join(" ");

const DISMISS_HINT = "Esc dismiss";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;

type BtwStatus = "running" | "complete" | "aborted" | "error";

interface BtwWidgetState {
  question: string;
  answer: string;
  status: BtwStatus;
  errorMessage?: string;
}

interface ActiveBtwRequest {
  id: number;
  abortController: AbortController;
}

interface BtwSessionRuntime {
  key: string;
  nextRequestId: number;
  activeRequest?: ActiveBtwRequest;
  visibleState?: BtwWidgetState;
  widgetRegistered: boolean;
  widgetTui?: TUI;
  spinnerFrame: number;
  spinnerTimer?: ReturnType<typeof setInterval>;
}

function getSessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile();
}

function extractResponseText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as Record<string, unknown>;
      if (typeof value.text === "string") return value.text;
      if (typeof value.refusal === "string") return value.refusal;
      return "";
    })
    .filter((text) => text.trim().length > 0)
    .join("\n")
    .trim();
}

function buildBtwMessages(ctx: ExtensionContext, question: string): Message[] {
  const sessionContext = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );

  return [
    ...sessionContext.messages,
    {
      role: "user",
      content: `Side question about the current session:\n\n${question}`,
      timestamp: Date.now(),
    },
  ];
}

function buildFooter(
  theme: ExtensionContext["ui"]["theme"],
  status: BtwStatus,
  spinnerFrame: number,
 ): string {
  switch (status) {
    case "running":
      return theme.fg("muted", DISMISS_HINT);
    case "complete":
      return theme.fg("muted", `Done. ${DISMISS_HINT}`);
    case "aborted":
      return theme.fg("warning", `Cancelled. ${DISMISS_HINT}`);
    case "error":
      return theme.fg("error", `Failed. ${DISMISS_HINT}`);
  }
}

function buildWidgetComponent(
  theme: ExtensionContext["ui"]["theme"],
  state: BtwWidgetState,
  spinnerFrame: number,
 ): Container {
  const container = new Container();
  const title = theme.fg("muted", "Side answer");
  const question = `${theme.fg("dim", theme.bold("Question"))} ${theme.fg("muted", state.question)}`;

  container.addChild(new DynamicBorder((text: string) => theme.fg("borderMuted", text)));
  container.addChild(new Spacer(1));
  container.addChild(new Text(title, 1, 0));
  container.addChild(new Text(question, 1, 0));
  container.addChild(new Spacer(1));

  if (state.status === "error") {
    container.addChild(
      new Text(theme.fg("error", state.errorMessage ?? "BTW request failed."), 1, 0),
    );
  } else if (!state.answer.trim()) {
    const waitingText =
      state.status === "aborted"
        ? "Request cancelled."
        : `${SPINNER_FRAMES[spinnerFrame] ?? SPINNER_FRAMES[0]} Waiting for response…`;
    const waitingTone = state.status === "running" ? "warning" : "dim";
    container.addChild(new Text(theme.fg(waitingTone, waitingText), 1, 0));
  } else {
    container.addChild(new Markdown(state.answer, 1, 0, getMarkdownTheme()));
  }

  container.addChild(new Spacer(1));
  container.addChild(new Text(buildFooter(theme, state.status, spinnerFrame), 1, 0));
  container.addChild(new Spacer(1));
  return container;
}

export default function btwExtension(pi: ExtensionAPI): void {
  const runtimes = new Map<string, BtwSessionRuntime>();
  let activeSessionKey: string | undefined;
  let lastUiContext: ExtensionContext | undefined;
  let removeTerminalListener: (() => void) | undefined;
  let mountedRuntimeKey: string | undefined;

  function getOrCreateRuntime(key: string): BtwSessionRuntime {
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = {
        key,
        nextRequestId: 1,
        widgetRegistered: false,
        spinnerFrame: 0,
      };
      runtimes.set(key, runtime);
    }
    return runtime;
  }

  function getActiveRuntime(): BtwSessionRuntime | undefined {
    if (!activeSessionKey) return undefined;
    return runtimes.get(activeSessionKey);
  }

  function setActiveSession(ctx: ExtensionContext): void {
    activeSessionKey = getSessionKey(ctx);
    if (ctx.hasUI) {
      lastUiContext = ctx;
      bindTerminalListener(ctx);
    }
  }

  function unmountWidget(ctx?: ExtensionContext): void {
    const activeCtx = ctx ?? lastUiContext;
    const runtimeKey = mountedRuntimeKey;
    if (!runtimeKey) return;

    if (activeCtx?.hasUI) {
      activeCtx.ui.setWidget(BTW_WIDGET_KEY, undefined);
    }

    const runtime = runtimes.get(runtimeKey);
    if (runtime) {
      runtime.widgetRegistered = false;
      runtime.widgetTui = undefined;
    }
    mountedRuntimeKey = undefined;
  }

  function ensureWidgetMounted(ctx: ExtensionContext, runtime: BtwSessionRuntime): void {
    if (!ctx.hasUI) return;
    if (mountedRuntimeKey === runtime.key && runtime.widgetRegistered) return;

    if (mountedRuntimeKey && mountedRuntimeKey !== runtime.key) {
      unmountWidget(ctx);
    }

    ctx.ui.setWidget(BTW_WIDGET_KEY, (tui, theme) => {
      runtime.widgetTui = tui;
      runtime.widgetRegistered = true;
      mountedRuntimeKey = runtime.key;

      return {
        render: (width: number) => {
          const state = runtime.visibleState;
          if (!state) return [];
          return buildWidgetComponent(theme, state, runtime.spinnerFrame).render(width);
        },
        invalidate: () => {
          runtime.widgetRegistered = false;
          runtime.widgetTui = undefined;
          if (mountedRuntimeKey === runtime.key) {
            mountedRuntimeKey = undefined;
          }
        },
      };
    });

    runtime.widgetRegistered = true;
    mountedRuntimeKey = runtime.key;
  }

  function renderRuntime(runtime: BtwSessionRuntime, ctx?: ExtensionContext): void {
    const activeCtx = ctx ?? lastUiContext;
    if (!activeCtx?.hasUI) return;
    if (activeSessionKey !== runtime.key) return;

    if (!runtime.visibleState) {
      if (mountedRuntimeKey === runtime.key) {
        const tui = runtime.widgetTui;
        unmountWidget(activeCtx);
        tui?.requestRender();
      }
      return;
    }

    ensureWidgetMounted(activeCtx, runtime);
    runtime.widgetTui?.requestRender();
  }

  function stopSpinner(runtime: BtwSessionRuntime): void {
    if (runtime.spinnerTimer) {
      clearInterval(runtime.spinnerTimer);
      runtime.spinnerTimer = undefined;
    }
    runtime.spinnerFrame = 0;
  }

  function syncSpinner(runtime: BtwSessionRuntime): void {
    if (runtime.visibleState?.status !== "running") {
      stopSpinner(runtime);
      return;
    }

    if (runtime.spinnerTimer) return;

    runtime.spinnerTimer = setInterval(() => {
      runtime.spinnerFrame = (runtime.spinnerFrame + 1) % SPINNER_FRAMES.length;
      if (activeSessionKey === runtime.key) {
        runtime.widgetTui?.requestRender();
      }
    }, SPINNER_INTERVAL_MS);
  }

  function updateRuntimeState(
    runtime: BtwSessionRuntime,
    state: BtwWidgetState | undefined,
    ctx?: ExtensionContext,
  ): void {
    runtime.visibleState = state;
    syncSpinner(runtime);
    renderRuntime(runtime, ctx);
  }

  function abortRuntime(runtime: BtwSessionRuntime): void {
    if (!runtime.activeRequest) return;
    const { abortController } = runtime.activeRequest;
    runtime.activeRequest = undefined;
    abortController.abort();
  }

  function clearRuntime(runtime: BtwSessionRuntime, ctx?: ExtensionContext): void {
    abortRuntime(runtime);
    stopSpinner(runtime);
    runtime.visibleState = undefined;

    const activeCtx = ctx ?? lastUiContext;
    if (!activeCtx?.hasUI) return;
    if (activeSessionKey !== runtime.key) return;

    const tui = runtime.widgetTui;
    if (runtime.widgetRegistered) {
      activeCtx.ui.setWidget(BTW_WIDGET_KEY, undefined);
    }
    runtime.widgetRegistered = false;
    runtime.widgetTui = undefined;
    if (mountedRuntimeKey === runtime.key) {
      mountedRuntimeKey = undefined;
    }
    tui?.requestRender();
  }

  function bindTerminalListener(ctx: ExtensionContext): void {
    removeTerminalListener?.();
    removeTerminalListener = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "escape")) return undefined;

      const runtime = getActiveRuntime();
      if (!runtime?.visibleState) return undefined;

      clearRuntime(runtime, ctx);
      return { consume: true };
    });
  }

  function restoreVisibleRuntime(ctx: ExtensionContext): void {
    setActiveSession(ctx);

    const runtime = getActiveRuntime();
    if (runtime?.visibleState) {
      renderRuntime(runtime, ctx);
      return;
    }

    unmountWidget(ctx);
  }

  async function runBtw(question: string, ctx: ExtensionCommandContext): Promise<void> {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      ctx.ui.notify("Usage: /btw <question>", "warning");
      return;
    }

    if (!ctx.hasUI) {
      ctx.ui.notify("/btw requires the interactive UI.", "error");
      return;
    }

    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No active model available for /btw.", "error");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(auth.error, "error");
      return;
    }

    setActiveSession(ctx);
    const runtime = getOrCreateRuntime(getSessionKey(ctx));
    abortRuntime(runtime);

    const request: ActiveBtwRequest = {
      id: runtime.nextRequestId++,
      abortController: new AbortController(),
    };
    const state: BtwWidgetState = {
      question: trimmedQuestion,
      answer: "",
      status: "running",
    };

    runtime.activeRequest = request;
    updateRuntimeState(runtime, state, ctx);

    try {
      const response = await complete(
        model,
        {
          systemPrompt: `${ctx.getSystemPrompt()}\n\n${BTW_SYSTEM_PROMPT}`,
          messages: buildBtwMessages(ctx, trimmedQuestion),
        },
        {
          signal: request.abortController.signal,
          reasoning: normalizeReasoningLevel(pi.getThinkingLevel()),
          apiKey: auth.apiKey,
          headers: auth.headers,
        },
      );

      if (runtime.activeRequest?.id !== request.id) {
        return;
      }

      const answer = extractResponseText(response.content);
      if (response.stopReason === "aborted") {
        state.status = "aborted";
        state.answer = answer;
      } else if (!answer) {
        state.status = "error";
        state.errorMessage = "BTW request returned an empty response.";
      } else {
        state.status = "complete";
        state.answer = answer;
      }

      updateRuntimeState(runtime, state, ctx);
    } catch (error) {
      if (runtime.activeRequest?.id !== request.id) {
        return;
      }

      state.status = request.abortController.signal.aborted ? "aborted" : "error";
      if (state.status === "error") {
        state.errorMessage = error instanceof Error ? error.message : String(error);
      }
      updateRuntimeState(runtime, state, ctx);
    } finally {
      if (runtime.activeRequest?.id === request.id) {
        runtime.activeRequest = undefined;
      }
    }
  }

  pi.registerCommand("btw", {
    description: "Ask a side question in a separate BTW widget",
    handler: async (args, ctx) => {
      void runBtw(args, ctx).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      });
    },
  });

  pi.registerCommand("btw:clear", {
    description: "Clear the BTW widget",
    handler: async (_args, ctx) => {
      setActiveSession(ctx);
      clearRuntime(getOrCreateRuntime(getSessionKey(ctx)), ctx);
      if (ctx.hasUI) {
        ctx.ui.notify("Cleared BTW widget.", "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreVisibleRuntime(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreVisibleRuntime(ctx);
  });

  pi.on("session_shutdown", async () => {
    removeTerminalListener?.();
    removeTerminalListener = undefined;
    for (const runtime of runtimes.values()) {
      abortRuntime(runtime);
      stopSpinner(runtime);
      runtime.visibleState = undefined;
      runtime.widgetRegistered = false;
      runtime.widgetTui = undefined;
    }
    mountedRuntimeKey = undefined;
    activeSessionKey = undefined;
    lastUiContext = undefined;
  });
}
