import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { loadHandoffConfig, updateHandoffConfig } from "./config.js";

export type HandoffMode = "kuafu" | "fuxi" | "houtu";
type HandoffModeState = { mode?: HandoffMode };
type PendingPreparedHandoff = { sessionFile: string; args: ParsedHandoffArgs; source?: string };
type PendingPreparedHandoffsGlobal = Map<string, PendingPreparedHandoff>;
type SummaryModelChoice = { value: string; model: any };
type SetupSessionManager = {
  appendCustomEntry?: (customType: string, data?: unknown) => unknown;
};

export interface DirectHandoffBridgeRequest {
  sessionFile: string;
  goal: string;
  mode: HandoffMode;
  summarize: boolean;
  source?: string;
}

export type DirectHandoffBridgeReply =
  | { success: true; data: { command: string; sessionFile: string; source?: string } }
  | { success: false; error: string };


export type PreparedHandoffArgsResolver = (ctx: ExtensionCommandContext) => ParsedHandoffArgs | null;
const PREPARED_HANDOFF_RESOLVER_KEY = Symbol.for("pi-config-handoff-args-resolver");

export function setPreparedHandoffArgsResolver(resolver: PreparedHandoffArgsResolver | null): void {
  if (resolver) {
    (globalThis as Record<PropertyKey, unknown>)[PREPARED_HANDOFF_RESOLVER_KEY] = resolver;
  } else {
    delete (globalThis as Record<PropertyKey, unknown>)[PREPARED_HANDOFF_RESOLVER_KEY];
  }
}

function getPreparedHandoffArgsResolver(): PreparedHandoffArgsResolver | null {
  const resolver = (globalThis as Record<PropertyKey, unknown>)[PREPARED_HANDOFF_RESOLVER_KEY];
  return typeof resolver === "function" ? resolver as PreparedHandoffArgsResolver : null;
}
const PENDING_PREPARED_HANDOFFS_GLOBAL_KEY = Symbol.for("pi-config-handoff-prepared");
// Stores the handoff startup prompt across the session switch boundary.
// pi.sendUserMessage() after ctx.newSession() routes to the OLD (disposed)
// AgentSession — each extension loading gets its own runtime closure. Instead,
// we stash the prompt here and the NEW session's session_start handler picks
// it up via consumeHandoffStartupPrompt() on the fresh pi instance.
const HANDOFF_STARTUP_PROMPT_KEY = Symbol.for("pi-config-handoff-startup-prompt");
const DIRECT_HANDOFF_BRIDGE_CHANNEL = "handoff:rpc:prepare";
const DIRECT_HANDOFF_BRIDGE_TIMEOUT_MS = 1000;
const DIRECT_HANDOFF_COMMAND = "/handoff:start-work";
const HANDOFF_MODES: HandoffMode[] = ["kuafu", "fuxi", "houtu"];
const HANDOFF_MODE_ALIASES: Record<string, HandoffMode> = {
  build: "kuafu",
  plan: "fuxi",
  execute: "houtu",
};
const SUMMARY_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

export interface ParsedHandoffArgs {
  goal: string;
  mode: HandoffMode;
  summarize: boolean;
}

export function getHandoffUsage(): string {
  return "Usage: /handoff [-mode <name>] [-no-summarize] <goal>";
}


export function getPreparedHandoffCommand(): string {
  return DIRECT_HANDOFF_COMMAND;
}

// ---------------------------------------------------------------------------
// Handoff startup prompt — crosses session switch boundary via globalThis.
// The NEW extension's session_start handler consumes this.
// ---------------------------------------------------------------------------

export function consumeHandoffStartupPrompt(): string | null {
  const raw = (globalThis as Record<PropertyKey, unknown>)[HANDOFF_STARTUP_PROMPT_KEY];
  delete (globalThis as Record<PropertyKey, unknown>)[HANDOFF_STARTUP_PROMPT_KEY];
  if (typeof raw !== "string" || !raw) return null;
  return raw;
}

function setHandoffStartupPrompt(prompt: string): void {
  (globalThis as Record<PropertyKey, unknown>)[HANDOFF_STARTUP_PROMPT_KEY] = prompt;
}

function clearHandoffStartupPrompt(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[HANDOFF_STARTUP_PROMPT_KEY];
}

export async function requestDirectHandoffBridge(
  pi: ExtensionAPI,
  request: DirectHandoffBridgeRequest,
): Promise<DirectHandoffBridgeReply> {
  const requestId = `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return await new Promise<DirectHandoffBridgeReply>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const replyChannel = `${DIRECT_HANDOFF_BRIDGE_CHANNEL}:reply:${requestId}`;
    const unsubscribe = pi.events.on(replyChannel, (raw: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      unsubscribe();

      const response = raw as DirectHandoffBridgeReply | null;
      if (!response || typeof response !== "object") {
        resolve({ success: false, error: "Invalid handoff bridge response." });
        return;
      }

      resolve(response);
    });

    timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      unsubscribe();
      resolve({ success: false, error: "Handoff bridge timed out." });
    }, DIRECT_HANDOFF_BRIDGE_TIMEOUT_MS);

    pi.events.emit(DIRECT_HANDOFF_BRIDGE_CHANNEL, { requestId, request });
  });
}

export function registerDirectHandoffBridge(pi: ExtensionAPI): () => void {
  return pi.events.on(DIRECT_HANDOFF_BRIDGE_CHANNEL, (raw: unknown) => {
    const params = raw as { requestId?: string; request?: DirectHandoffBridgeRequest } | null;
    if (!params || typeof params.requestId !== "string") {
      return;
    }

    const replyChannel = `${DIRECT_HANDOFF_BRIDGE_CHANNEL}:reply:${params.requestId}`;

    try {
      const pending = normalizeDirectHandoffBridgeRequest(params.request);
      setPendingPreparedHandoff(pending);
      pi.events.emit(replyChannel, {
        success: true,
        data: {
          command: DIRECT_HANDOFF_COMMAND,
          sessionFile: pending.sessionFile,
          ...(pending.source ? { source: pending.source } : {}),
        },
      } satisfies DirectHandoffBridgeReply);
    } catch (error) {
      pi.events.emit(replyChannel, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies DirectHandoffBridgeReply);
    }
  });
}

export async function runPreparedHandoffCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  if (!currentSessionFile) {
    return "Current session file is unavailable for prepared handoff.";
  }

  const pending = getPendingPreparedHandoff(currentSessionFile);
  const args = pending?.args ?? getPreparedHandoffArgsResolver()?.(ctx);
  if (!args) {
    return `No prepared handoff found for this session. Prepare Hou Tu handoff first, then run ${DIRECT_HANDOFF_COMMAND}.`;
  }

  return await runHandoffCommand(pi, ctx, args);
}

export function parseHandoffArgs(args: string): { ok: true; value: ParsedHandoffArgs } | { ok: false; error: string } {
  let remaining = args.trim();
  let summarize = true;
  let modeInput: string | undefined;

  const modeMatch = remaining.match(/(?:^|\s)-mode\s+(\S+)/u);
  if (modeMatch) {
    modeInput = modeMatch[1];
    remaining = remaining.replace(modeMatch[0], " ");
  }

  const noSummarizeMatch = remaining.match(/(?:^|\s)-no-summarize(?=\s|$)/u);
  if (noSummarizeMatch) {
    summarize = false;
    remaining = remaining.replace(noSummarizeMatch[0], " ");
  }

  const summarizeValueMatch = remaining.match(/(?:^|\s)-(?:summarize|shouldSummarize)\s+(true|false)(?=\s|$)/iu);
  if (summarizeValueMatch) {
    summarize = summarizeValueMatch[1].toLowerCase() === "true";
    remaining = remaining.replace(summarizeValueMatch[0], " ");
  }

  const goal = stripMatchingQuotes(remaining.trim());
  if (!goal) {
    return { ok: false, error: getHandoffUsage() };
  }

  const mode = resolveMode(modeInput);
  if (!mode) {
    return {
      ok: false,
      error: `Unknown mode: \"${modeInput}\". Available: ${HANDOFF_MODES.join(", ")}`,
    };
  }

  return {
    ok: true,
    value: {
      goal,
      mode,
      summarize,
    },
  };
}

export async function runHandoffCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: ParsedHandoffArgs,
): Promise<string | undefined> {
  if (!ctx.hasUI) {
    return "handoff requires interactive mode";
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();
  if (!currentSessionFile) {
    return "Handoff requires a persisted session (in-memory sessions are not supported).";
  }
  const messages = collectConversationMessages(ctx.sessionManager.getBranch());

  let finalPrompt: string;
  if (args.summarize && messages.length > 0) {
    const summaryModel = await resolveSummaryModelChoice(ctx);
    if (!summaryModel) {
      return "Handoff cancelled.";
    }

    const summary = await generateContextSummaryWithUi(ctx, summaryModel, messages, args.goal);
    if (summary === null) {
      return "Handoff cancelled.";
    }

    finalPrompt = buildSummarizedPrompt(args.goal, currentSessionFile, summary);
  } else {
    finalPrompt = buildDeterministicPrompt(args.goal, currentSessionFile);
  }

  // Store the prompt in globalThis BEFORE switching sessions.
  // After ctx.newSession(), the old pi.sendUserMessage() routes to the OLD disposed
  // AgentSession (each extension load gets its own runtime closure). The new
  // session_start handler on the fresh extension instance picks this up instead.
  setHandoffStartupPrompt(finalPrompt);

  try {
    await ctx.waitForIdle();
    const result = await ctx.newSession({
      parentSession: currentSessionFile,
      setup: async (sessionManager: SetupSessionManager) => {
        seedChildSessionMode(sessionManager, args.mode);
      },
    });

    if (result.cancelled) {
      clearHandoffStartupPrompt();
      return "New session cancelled.";
    }
    // Prompt delivery is handled by session_start on the new extension instance.
  } catch (error) {
    clearHandoffStartupPrompt();
    return `Handoff failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (currentSessionFile) {
    clearPendingPreparedHandoff(currentSessionFile);
  }

  return undefined;
}

export function buildPlanExecutionGoal(planPath: string): string {
  return [
    `Execute work described in approved plan at ${planPath}.`,
    "",
    "Requirements:",
    "- Read the full plan before making changes.",
    "- Break each unchecked plan item into concrete implementation tasks before editing.",
    "- Re-read relevant files from current repo state before changing anything.",
    "- For each task, identify files to change, expected behavior, and verification.",
    "- Execute step by step until complete or truly blocked.",
  ].join("\n");
}

function getPendingPreparedHandoffsGlobal(): PendingPreparedHandoffsGlobal {
  const existing = (globalThis as Record<PropertyKey, unknown>)[PENDING_PREPARED_HANDOFFS_GLOBAL_KEY];
  if (existing instanceof Map) {
    return existing as PendingPreparedHandoffsGlobal;
  }

  const prepared = new Map<string, PendingPreparedHandoff>();
  (globalThis as Record<PropertyKey, unknown>)[PENDING_PREPARED_HANDOFFS_GLOBAL_KEY] = prepared;
  return prepared;
}

function getPendingPreparedHandoff(sessionFile: string): PendingPreparedHandoff | null {
  return getPendingPreparedHandoffsGlobal().get(sessionFile) ?? null;
}

function setPendingPreparedHandoff(pending: PendingPreparedHandoff): void {
  getPendingPreparedHandoffsGlobal().set(pending.sessionFile, pending);
}

function clearPendingPreparedHandoff(sessionFile: string): void {
  const prepared = getPendingPreparedHandoffsGlobal();
  prepared.delete(sessionFile);
  if (prepared.size === 0) {
    delete (globalThis as Record<PropertyKey, unknown>)[PENDING_PREPARED_HANDOFFS_GLOBAL_KEY];
  }
}

function normalizeDirectHandoffBridgeRequest(request?: DirectHandoffBridgeRequest): PendingPreparedHandoff {
  if (!request) {
    throw new Error("Missing handoff bridge request.");
  }

  const sessionFile = typeof request.sessionFile === "string" ? request.sessionFile.trim() : "";
  if (!sessionFile) {
    throw new Error("Missing handoff bridge session file.");
  }

  const goal = stripMatchingQuotes(typeof request.goal === "string" ? request.goal.trim() : "");
  if (!goal) {
    throw new Error("Missing handoff goal.");
  }

  const mode = resolveMode(request.mode);
  if (!mode) {
    throw new Error(`Unknown mode: "${String(request.mode)}". Available: ${HANDOFF_MODES.join(", ")}`);
  }

  if (typeof request.summarize !== "boolean") {
    throw new Error("Handoff summarize must be boolean.");
  }

  const source = typeof request.source === "string" ? request.source.trim() || undefined : undefined;
  return {
    sessionFile,
    args: { goal, mode, summarize: request.summarize },
    source,
  };
}

function stripMatchingQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed.trim() : value.slice(1, -1).trim();
    } catch {
      return value.slice(1, -1).trim();
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function resolveMode(value?: string | HandoffMode): HandoffMode | null {
  if (!value) {
    return "kuafu";
  }

  const normalized = value.trim().toLowerCase();
  return HANDOFF_MODE_ALIASES[normalized] ?? (HANDOFF_MODES.includes(normalized as HandoffMode) ? (normalized as HandoffMode) : null);
}

function collectConversationMessages(entries: SessionEntry[]): Array<SessionEntry & { type: "message" }> {
  return entries.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message");
}

async function resolveSummaryModelChoice(ctx: ExtensionContext): Promise<SummaryModelChoice | null> {
  const currentModelValue = getCurrentModelValue(ctx);
  const remembered = loadHandoffConfig().lastSummaryModel;
  const models = collectSummaryModels(ctx);
  const preferred = findAvailableModelChoice(remembered, models) ?? findAvailableModelChoice(currentModelValue, models);

  if (preferred) {
    return preferred;
  }

  if (models.length === 0) {
    throw new Error("No summary model is available.");
  }

  const selectedValue = await ctx.ui.select("Summary model", models.map(({ value }) => value));
  if (!selectedValue) {
    return null;
  }

  const selected = models.find((entry) => entry.value === selectedValue);
  if (!selected) {
    throw new Error(`Unknown summary model selection: ${selectedValue}`);
  }

  return selected;
}

function findAvailableModelChoice(value: string | null | undefined, models: SummaryModelChoice[]): SummaryModelChoice | undefined {
  if (!value) {
    return undefined;
  }
  return models.find((entry) => entry.value === value);
}

function collectSummaryModels(ctx: ExtensionContext): SummaryModelChoice[] {
  const seen = new Set<string>();
  const models: SummaryModelChoice[] = [];

  const add = (model: any) => {
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
      return;
    }

    const value = `${model.provider}/${model.id}`;
    if (seen.has(value)) {
      return;
    }

    seen.add(value);
    models.push({ value, model });
  };

  try {
    for (const model of ctx.modelRegistry.getAvailable?.() ?? []) {
      add(model);
    }
  } catch (error) {
    console.error("Failed to collect available summary models:", error);
  }

  if (ctx.model) {
    add(ctx.model);
  }

  return models;
}

function getCurrentModelValue(ctx: ExtensionContext): string | null {
  if (!ctx.model || typeof ctx.model.provider !== "string" || typeof ctx.model.id !== "string") {
    return null;
  }
  return `${ctx.model.provider}/${ctx.model.id}`;
}

async function generateContextSummaryWithUi(
  ctx: ExtensionContext,
  summaryModel: SummaryModelChoice,
  messages: Array<SessionEntry & { type: "message" }>,
  goal: string,
): Promise<string | null> {
  return await ctx.ui.custom<string | null>((tui: any, theme: any, _keybindings: any, done: (value: string | null) => void) => {
    const loader = new BorderedLoader(tui, theme, `Generating handoff prompt with ${summaryModel.value}...`);
    loader.onAbort = () => done(null);

    const run = async () => {
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel.model);
        if (!auth.ok) {
          throw new Error(auth.error || `No auth available for ${summaryModel.value}`);
        }

        const summary = await generateContextSummary(
          summaryModel.model,
          auth.apiKey,
          auth.headers,
          messages,
          goal,
          loader.signal,
        );

        if (summary && summary.trim().length > 0) {
          updateHandoffConfig({ lastSummaryModel: summaryModel.value });
        }

        done(summary);
      } catch (error) {
        console.error("Handoff generation failed:", error);
        done(null);
      }
    };

    void run();
    return loader;
  });
}

async function generateContextSummary(
  model: any,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  messages: Array<SessionEntry & { type: "message" }>,
  goal: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const conversationText = serializeConversation(convertToLlm(messages.map((entry) => entry.message)));
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey, headers, signal },
  );

  if (response.stopReason === "aborted") {
    return null;
  }

  return response.content
    .filter((block: any): block is { type: "text"; text: string } => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("\n")
    .trim();
}

function buildSummarizedPrompt(goal: string, parentSession: string | undefined, summary: string): string {
  const sections = [goal, ""];
  if (parentSession) {
    sections.push(`**Parent session:** \`${parentSession}\``, "");
  }
  sections.push(summary.trim());
  return sections.join("\n");
}

function buildDeterministicPrompt(goal: string, parentSession: string | undefined): string {
  const sections = [
    "Continue this work in a new child session.",
    "",
    "## Goal",
    goal,
  ];

  if (parentSession) {
    sections.push("", "## Context", `- Parent session: \`${parentSession}\``);
  }

  sections.push(
    "",
    "## Instructions",
    "- Start from the current repo state.",
    "- Re-read relevant files before changing anything.",
    "- Verify assumptions against the latest code.",
  );

  return sections.join("\n");
}

function seedChildSessionMode(sessionManager: SetupSessionManager, mode: HandoffMode): void {
  sessionManager.appendCustomEntry?.("agent-mode", { mode } satisfies HandoffModeState);
}
