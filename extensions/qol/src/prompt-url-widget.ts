import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { isTui } from "../../lib/mode.js";

const PR_PROMPT_PATTERN =
  /^\s*You are given one or more GitHub PR URLs:\s*(\S+)/im;
const ISSUE_PROMPT_PATTERN = /^\s*Analyze GitHub issue\(s\):\s*(\S+)/im;

type PromptMatch = {
  kind: "pr" | "issue";
  url: string;
};

type GhMetadata = {
  title?: string;
  author?: {
    login?: string;
    name?: string | null;
  };
};

function extractPromptMatch(prompt: string): PromptMatch | undefined {
  const prMatch = prompt.match(PR_PROMPT_PATTERN);
  if (prMatch?.[1]) {
    return { kind: "pr", url: prMatch[1].trim() };
  }

  const issueMatch = prompt.match(ISSUE_PROMPT_PATTERN);
  if (issueMatch?.[1]) {
    return { kind: "issue", url: issueMatch[1].trim() };
  }

  return undefined;
}

async function fetchGhMetadata(
  pi: ExtensionAPI,
  kind: PromptMatch["kind"],
  url: string,
): Promise<GhMetadata | undefined> {
  const args =
    kind === "pr"
      ? ["pr", "view", url, "--json", "title,author"]
      : ["issue", "view", url, "--json", "title,author"];

  try {
    const result = await pi.exec("gh", args);
    if (result.code !== 0 || !result.stdout) return undefined;
    return JSON.parse(result.stdout) as GhMetadata;
  } catch {
    return undefined;
  }
}

function formatAuthor(author?: GhMetadata["author"]): string | undefined {
  if (!author) return undefined;
  const name = author.name?.trim();
  const login = author.login?.trim();
  if (name && login) return `${name} (@${login})`;
  if (login) return `@${login}`;
  if (name) return name;
  return undefined;
}

export default function promptUrlWidgetExtension(pi: ExtensionAPI) {
  let disposed = false;
  const setWidget = (
    ctx: ExtensionContext,
    match: PromptMatch,
    title?: string,
    authorText?: string,
  ) => {
    if (!isTui(ctx)) return;
    ctx.ui.setWidget("prompt-url", (_tui, thm) => {
      const titleText = title
        ? thm.fg("accent", title)
        : thm.fg("accent", match.url);
      const authorLine = authorText ? thm.fg("muted", authorText) : undefined;
      const urlLine = thm.fg("dim", match.url);

      const lines = [titleText];
      if (authorLine) lines.push(authorLine);
      lines.push(urlLine);

      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => thm.fg("muted", s)));
      container.addChild(new Text(lines.join("\n"), 1, 0));
      return container;
    });
  };

  const applySessionName = (
    ctx: ExtensionContext,
    match: PromptMatch,
    title?: string,
  ) => {
    const label = match.kind === "pr" ? "PR" : "Issue";
    const trimmedTitle = title?.trim();
    const fallbackName = `${label}: ${match.url}`;
    const desiredName = trimmedTitle
      ? `${label}: ${trimmedTitle} (${match.url})`
      : fallbackName;
    const currentName = pi.getSessionName()?.trim();
    if (!currentName) {
      pi.setSessionName(desiredName);
      return;
    }
    if (currentName === match.url || currentName === fallbackName) {
      pi.setSessionName(desiredName);
    }
  };

  pi.on("before_agent_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    // Pi 1.2 also fires this for runs started by pi.sendMessage(..., { triggerTurn: true });
    // those carry no prompt (pi#10739). `in` narrows the 1.2.0 union and compiles on 1.1.0 types.
    const prompt = "prompt" in event ? event.prompt : undefined;
    if (!prompt) return;
    const match = extractPromptMatch(prompt);
    if (!match) {
      return;
    }

    setWidget(ctx, match);
    applySessionName(ctx, match);
    void fetchGhMetadata(pi, match.kind, match.url).then((meta) => {
      if (disposed) return;
      const title = meta?.title?.trim();
      const authorText = formatAuthor(meta?.author);
      setWidget(ctx, match, title, authorText);
      applySessionName(ctx, match, title);
    }).catch(() => undefined); // Best-effort UI enrichment can race with disposal.
  });

  const getUserText = (
    content: string | { type: string; text?: string }[] | undefined,
  ): string => {
    if (!content) return "";
    if (typeof content === "string") return content;
    return (
      content
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("\n") ?? ""
    );
  };

  const rebuildFromSession = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const entries = ctx.sessionManager.getEntries();
    const lastMatch = [...entries].reverse().find((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user")
        return false;
      const text = getUserText(entry.message.content);
      return !!extractPromptMatch(text);
    });

    const content =
      lastMatch?.type === "message" && lastMatch.message.role === "user"
        ? lastMatch.message.content
        : undefined;
    const text = getUserText(content);
    const match = text ? extractPromptMatch(text) : undefined;
    if (!match) {
      if (isTui(ctx)) ctx.ui.setWidget("prompt-url", undefined);
      return;
    }

    setWidget(ctx, match);
    applySessionName(ctx, match);
    void fetchGhMetadata(pi, match.kind, match.url).then((meta) => {
      if (disposed) return;
      const title = meta?.title?.trim();
      const authorText = formatAuthor(meta?.author);
      setWidget(ctx, match, title, authorText);
      applySessionName(ctx, match, title);
    }).catch(() => undefined); // Best-effort UI enrichment can race with disposal.
  };

  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    rebuildFromSession(ctx);
  });

  pi.on("session_shutdown", async () => {
    disposed = true;
  });
}
