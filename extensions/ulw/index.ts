import { ULTRAWORK_PROMPT } from "./prompt.js";

interface UlwTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface UlwUi {
  theme: UlwTheme;
  notify(message: string, level: "info" | "warning" | "error" | "success"): void;
  setStatus(key: string, text: string | undefined): void;
}

interface UlwSessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface UlwSessionManager {
  getEntries(): UlwSessionEntry[];
}

interface UlwContext {
  hasUI: boolean;
  ui: UlwUi;
  sessionManager: UlwSessionManager;
}

interface UlwInputEvent {
  text: string;
  source: "interactive" | "rpc" | "extension";
}

interface UlwMessageEndEvent {
  message?: {
    role?: string;
  };
}

interface UlwTextContentPart {
  type: "text";
  text: string;
  [key: string]: unknown;
}

interface UlwContentPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

type UlwMessageContent = string | UlwContentPart[];

interface UlwContextMessage {
  role?: string;
  content?: UlwMessageContent;
}

interface UlwContextEvent {
  messages: UlwContextMessage[];
}

interface UlwExtensionApi {
  on(
    event: "session_start" | "session_shutdown",
    handler: (_event: unknown, ctx: UlwContext) => Promise<void> | void,
  ): void;
  on(
    event: "input",
    handler: (
      event: UlwInputEvent,
      ctx: UlwContext,
    ) =>
      | Promise<{ action: "continue" | "transform"; text?: string } | void>
      | { action: "continue" | "transform"; text?: string }
      | void,
  ): void;
  on(
    event: "message_end",
    handler: (_event: UlwMessageEndEvent, ctx: UlwContext) => Promise<void> | void,
  ): void;
  on(
    event: "context",
    handler: (
      event: UlwContextEvent,
      ctx: UlwContext,
    ) => Promise<{ messages: UlwContextMessage[] } | void> | { messages: UlwContextMessage[] } | void,
  ): void;
  appendEntry(customType: string, data: unknown): void;
}

interface UlwPersistedState {
  enabled?: boolean;
}

const ULTRAWORK_WORD_DETECT_PATTERN = /\b(?:ultrawork|ulw)\b/i;
const ULTRAWORK_WORD_STRIP_PATTERN = /\b(?:ultrawork|ulw)\b/gi;
const ULTRAWORK_SHORTCUT_DETECT_PATTERN = /(^|\s)\/\.(?=\s|$)/;
const ULTRAWORK_SHORTCUT_STRIP_PATTERN = /(^|\s)\/\.(?=\s|$)/g;
const FENCED_CODE_PATTERN = /(^|\n)[ \t]*(```|~~~)[\s\S]*?\n[ \t]*\2[^\n]*(?=\n|$)/g;
const INLINE_CODE_PATTERN = /`[^`\n]+`/g;
const STATE_KEY = "ulw-state";
const STATUS_KEY = "ulw";
const ENABLED_TEXT = "✓ ULTRAWORK MODE ENABLED";
const EMPTY_FALLBACK_PROMPT = "Continue in ultrawork mode.";

function stripCodeForDetection(text: string): string {
  return text.replace(FENCED_CODE_PATTERN, "$1").replace(INLINE_CODE_PATTERN, "");
}

function hasUltraworkTrigger(text: string): boolean {
  const stripped = stripCodeForDetection(text);
  return ULTRAWORK_WORD_DETECT_PATTERN.test(stripped) || ULTRAWORK_SHORTCUT_DETECT_PATTERN.test(stripped);
}

function stripUltraworkKeywords(text: string): string {
  return text
    .replace(ULTRAWORK_WORD_STRIP_PATTERN, " ")
    .replace(ULTRAWORK_SHORTCUT_STRIP_PATTERN, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function buildInjectedUserMessage(userText: string): string {
  const normalized = userText.trim() || EMPTY_FALLBACK_PROMPT;
  return `${ULTRAWORK_PROMPT}\n\n<user-request>\n${normalized}\n</user-request>`;
}

function extractUserText(content: UlwMessageContent | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part): part is UlwTextContentPart => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function injectUltraworkIntoContent(content: UlwMessageContent | undefined): UlwMessageContent {
  const wrappedText = buildInjectedUserMessage(extractUserText(content));

  if (typeof content === "string" || !Array.isArray(content)) {
    return wrappedText;
  }

  const rewritten: UlwContentPart[] = [];
  let injected = false;

  for (const part of content) {
    if (!injected && part?.type === "text") {
      rewritten.push({ ...part, type: "text", text: wrappedText });
      injected = true;
      continue;
    }

    if (part?.type === "text") {
      continue;
    }

    rewritten.push(part);
  }

  if (!injected) {
    rewritten.unshift({ type: "text", text: wrappedText });
  }

  return rewritten;
}

function injectUltraworkIntoMessages(messages: UlwContextMessage[]): UlwContextMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }

    return messages.map((entry, currentIndex) => {
      if (currentIndex !== index) {
        return entry;
      }

      return {
        ...entry,
        content: injectUltraworkIntoContent(entry.content),
      };
    });
  }

  return messages;
}

function formatStatus(ctx: UlwContext): string {
  return ctx.ui.theme.bold(ctx.ui.theme.fg("success", ENABLED_TEXT));
}

function setStatus(ctx: UlwContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx));
}

function clearStatus(ctx: UlwContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

function restoreUltraworkState(ctx: UlwContext): boolean {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== STATE_KEY) {
      continue;
    }

    const data = entry.data as UlwPersistedState | undefined;
    return data?.enabled === true;
  }

  return false;
}

export default function ulwExtension(pi: UlwExtensionApi): void {
  let ultraworkEnabled = false;
  let pendingAnnouncement = false;

  pi.on("session_start", async (_event, ctx) => {
    ultraworkEnabled = restoreUltraworkState(ctx);
    pendingAnnouncement = false;

    if (ultraworkEnabled) {
      setStatus(ctx);
      return;
    }

    clearStatus(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" as const };
    }

    if (!hasUltraworkTrigger(event.text)) {
      return { action: "continue" as const };
    }

    const strippedPrompt = stripUltraworkKeywords(event.text);
    const wasEnabled = ultraworkEnabled;
    ultraworkEnabled = true;
    setStatus(ctx);

    if (!wasEnabled) {
      pendingAnnouncement = true;
      pi.appendEntry(STATE_KEY, { enabled: true });
    }

    return {
      action: "transform" as const,
      text: strippedPrompt || EMPTY_FALLBACK_PROMPT,
    };
  });

  pi.on("message_end", async (event, ctx) => {
    if (!pendingAnnouncement || event.message?.role !== "user") {
      return;
    }

    pendingAnnouncement = false;
    setStatus(ctx);

    if (ctx.hasUI) {
      ctx.ui.notify(ENABLED_TEXT, "success");
    }
  });

  pi.on("context", async (event) => {
    if (!ultraworkEnabled) return;

    return {
      messages: injectUltraworkIntoMessages(event.messages),
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ultraworkEnabled = false;
    pendingAnnouncement = false;
    clearStatus(ctx);
  });
}
