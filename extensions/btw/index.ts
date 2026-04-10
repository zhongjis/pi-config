import {
  DynamicBorder,
  buildSessionContext,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  streamSimple,
  type AssistantMessage,
  type Message,
} from "@mariozechner/pi-ai";
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
  state: BtwWidgetState;
}

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
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

function buildFooter(theme: ExtensionContext["ui"]["theme"], status: BtwStatus): string {
  switch (status) {
    case "running":
      return theme.fg("muted", `Running… ${DISMISS_HINT}`);
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
      state.status === "aborted" ? "Request cancelled." : "Waiting for response…";
    container.addChild(new Text(theme.fg("dim", waitingText), 1, 0));
  } else {
    container.addChild(new Markdown(state.answer, 1, 0, getMarkdownTheme()));
  }

  container.addChild(new Spacer(1));
  container.addChild(new Text(buildFooter(theme, state.status), 1, 0));
  container.addChild(new Spacer(1));
  return container;
}

export default function btwExtension(pi: ExtensionAPI): void {
  let activeRequest: ActiveBtwRequest | undefined;
  let nextRequestId = 1;
  let lastUiContext: ExtensionContext | undefined;
  let visibleState: BtwWidgetState | undefined;
  let removeTerminalListener: (() => void) | undefined;
  let widgetTui: TUI | undefined;

  function renderWidget(ctx: ExtensionContext, state: BtwWidgetState | undefined): void {
    if (!ctx.hasUI) return;

    if (!state) {
      const tui = widgetTui;
      ctx.ui.setWidget(BTW_WIDGET_KEY, undefined);
      widgetTui = undefined;
      tui?.requestRender(true);
      return;
    }

    ctx.ui.setWidget(BTW_WIDGET_KEY, (tui, theme) => {
      widgetTui = tui;
      return buildWidgetComponent(theme, state);
    });
  }

  function clearWidget(ctx?: ExtensionContext): void {
    visibleState = undefined;
    const activeCtx = ctx ?? lastUiContext;
    if (!activeCtx?.hasUI) return;
    renderWidget(activeCtx, undefined);
  }

  function updateWidget(state: BtwWidgetState, ctx?: ExtensionContext): void {
    visibleState = state;
    const activeCtx = ctx ?? lastUiContext;
    if (!activeCtx?.hasUI) return;
    renderWidget(activeCtx, state);
  }

  function bindTerminalListener(ctx: ExtensionContext): void {
    removeTerminalListener?.();
    removeTerminalListener = ctx.ui.onTerminalInput((data) => {
      if (!visibleState) return undefined;
      if (!matchesKey(data, "escape")) return undefined;
      resetState(ctx);
      return { consume: true };
    });
  }

  function abortActiveRequest(): void {
    if (!activeRequest) return;
    activeRequest.abortController.abort();
    activeRequest = undefined;
  }

  function resetState(ctx?: ExtensionContext): void {
    abortActiveRequest();
    clearWidget(ctx);
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

    lastUiContext = ctx;
    abortActiveRequest();

    const request: ActiveBtwRequest = {
      id: nextRequestId++,
      abortController: new AbortController(),
      state: {
        question: trimmedQuestion,
        answer: "",
        status: "running",
      },
    };
    activeRequest = request;
    updateWidget(request.state, ctx);

    try {
      const stream = streamSimple(
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

      for await (const event of stream) {
        if (activeRequest?.id !== request.id) {
          return;
        }

        if (event.type === "text_delta") {
          request.state.answer += event.delta;
          updateWidget(request.state);
          continue;
        }

        if (event.type === "done") {
          request.state.answer = extractAssistantText(event.message);
          request.state.status = "complete";
          updateWidget(request.state);
          return;
        }

        if (event.type === "error") {
          request.state.status = event.reason === "aborted" ? "aborted" : "error";
          request.state.errorMessage = event.error.errorMessage ?? "BTW request failed.";
          if (!request.state.answer.trim()) {
            request.state.answer = extractAssistantText(event.error);
          }
          updateWidget(request.state);
          return;
        }
      }
    } catch (error) {
      if (activeRequest?.id !== request.id) {
        return;
      }

      request.state.status = request.abortController.signal.aborted ? "aborted" : "error";
      request.state.errorMessage = error instanceof Error ? error.message : String(error);
      updateWidget(request.state);
    } finally {
      if (activeRequest?.id === request.id && request.state.status !== "running") {
        activeRequest = undefined;
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
      resetState(ctx);
      ctx.ui.notify("Cleared BTW widget.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    lastUiContext = ctx;
    bindTerminalListener(ctx);
    resetState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    lastUiContext = ctx;
    resetState(ctx);
  });

  pi.on("session_shutdown", async () => {
    removeTerminalListener?.();
    removeTerminalListener = undefined;
    resetState();
  });
}
