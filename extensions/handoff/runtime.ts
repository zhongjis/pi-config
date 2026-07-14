import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete, type Message } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { loadHandoffConfig, updateHandoffConfig } from "./config.js";
import { isTui } from "../lib/mode.js";
import { rpcCall, registerRpcHandler } from "../lib/rpc.js";
import { MODE_ALIASES, MODES } from "../modes/src/constants.js";
import type { Mode } from "../modes/src/types.js";

export type HandoffMode = Mode;
type HandoffModeState = { mode?: HandoffMode };
type PendingPreparedHandoff = {
  sessionFile: string;
  args: ParsedHandoffArgs;
  source?: string;
};
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
  | {
      success: true;
      data: { command: string; sessionFile: string; source?: string };
    }
  | { success: false; error: string };

export type PreparedHandoffArgsResolver = (
  ctx: ExtensionCommandContext,
) => ParsedHandoffArgs | null;
const PREPARED_HANDOFF_RESOLVER_KEY = Symbol.for(
  "pi-config-handoff-args-resolver",
);

export function setPreparedHandoffArgsResolver(
  resolver: PreparedHandoffArgsResolver | null,
): void {
  if (resolver) {
    (globalThis as Record<PropertyKey, unknown>)[
      PREPARED_HANDOFF_RESOLVER_KEY
    ] = resolver;
  } else {
    delete (globalThis as Record<PropertyKey, unknown>)[
      PREPARED_HANDOFF_RESOLVER_KEY
    ];
  }
}

function getPreparedHandoffArgsResolver(): PreparedHandoffArgsResolver | null {
  const resolver = (globalThis as Record<PropertyKey, unknown>)[
    PREPARED_HANDOFF_RESOLVER_KEY
  ];
  return typeof resolver === "function"
    ? (resolver as PreparedHandoffArgsResolver)
    : null;
}
const PENDING_PREPARED_HANDOFFS_GLOBAL_KEY = Symbol.for(
  "pi-config-handoff-prepared",
);
// Stores the handoff startup prompt across the session switch boundary.
// pi.sendUserMessage() after ctx.newSession() routes to the OLD (disposed)
// AgentSession — each extension loading gets its own runtime closure. Instead,
// we stash the prompt here and the NEW session's session_start handler picks
// it up via consumeHandoffStartupPrompt() on the fresh pi instance.
const HANDOFF_STARTUP_PROMPT_KEY = Symbol.for(
  "pi-config-handoff-startup-prompt",
);
// DIRECT_HANDOFF_BRIDGE_CHANNEL removed — channel name is built internally by rpcCall/registerRpcHandler
const DIRECT_HANDOFF_BRIDGE_TIMEOUT_MS = 1000;
const DIRECT_HANDOFF_COMMAND = "/handoff:start-work";
const HANDOFF_MODES: readonly HandoffMode[] = MODES;
const HANDOFF_MODE_ALIASES: Record<string, HandoffMode> = MODE_ALIASES;
const SUMMARY_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation
5. Suggests skills the new agent should load for the next task, when any are clearly relevant

Rules:
- Do NOT duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.
- Redact any sensitive information (API keys, tokens, passwords, personally identifiable information). Never copy secrets into the prompt.

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Suggested skills
- skill-name — why it helps

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
  const raw = (globalThis as Record<PropertyKey, unknown>)[
    HANDOFF_STARTUP_PROMPT_KEY
  ];
  delete (globalThis as Record<PropertyKey, unknown>)[
    HANDOFF_STARTUP_PROMPT_KEY
  ];
  if (typeof raw !== "string" || !raw) return null;
  return raw;
}

function setHandoffStartupPrompt(prompt: string): void {
  (globalThis as Record<PropertyKey, unknown>)[HANDOFF_STARTUP_PROMPT_KEY] =
    prompt;
}

function clearHandoffStartupPrompt(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[
    HANDOFF_STARTUP_PROMPT_KEY
  ];
}

export async function requestDirectHandoffBridge(
  pi: ExtensionAPI,
  request: DirectHandoffBridgeRequest,
): Promise<DirectHandoffBridgeReply> {
  try {
    const data = await rpcCall<{
      command: string;
      sessionFile: string;
      source?: string;
    }>(
      pi,
      "handoff",
      "prepare",
      { request },
      { timeout: DIRECT_HANDOFF_BRIDGE_TIMEOUT_MS },
    );
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerDirectHandoffBridge(pi: ExtensionAPI): () => void {
  return registerRpcHandler(pi, "handoff", "prepare", (raw, _requestId) => {
    const params = raw as { request?: DirectHandoffBridgeRequest } | null;
    const pending = normalizeDirectHandoffBridgeRequest(params?.request);
    setPendingPreparedHandoff(pending);
    return {
      command: DIRECT_HANDOFF_COMMAND,
      sessionFile: pending.sessionFile,
      ...(pending.source ? { source: pending.source } : {}),
    };
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

export function parseHandoffArgs(
  args: string,
): { ok: true; value: ParsedHandoffArgs } | { ok: false; error: string } {
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

  const summarizeValueMatch = remaining.match(
    /(?:^|\s)-(?:summarize|shouldSummarize)\s+(true|false)(?=\s|$)/iu,
  );
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
    if (!isTui(ctx)) {
      return "Handoff --summarize requires interactive (TUI) mode. Re-run without --summarize for a deterministic prompt.";
    }
    const summaryModel = await resolveSummaryModelChoice(ctx);
    if (!summaryModel) {
      return "Handoff cancelled.";
    }

    const summary = await generateContextSummaryWithUi(
      ctx,
      summaryModel,
      messages,
      args.goal,
    );
    if (summary === null) {
      return "Handoff cancelled.";
    }

    finalPrompt = buildSummarizedPrompt(args.goal, currentSessionFile, summary);
  } else {
    finalPrompt = buildDeterministicPrompt(args.goal, currentSessionFile);
  }

  try {
    await ctx.waitForIdle();
    const result = await (ctx.newSession as any)({
      parentSession: currentSessionFile,
      setup: async (sessionManager: SetupSessionManager) => {
        seedChildSessionMode(sessionManager, args.mode);
      },
      withSession: async (replacementCtx: ExtensionContext) => {
        if (!replacementCtx.hasUI) return;
        replacementCtx.ui.setEditorText(finalPrompt);
        replacementCtx.ui.notify(
          "Handoff ready. Press Enter to start.",
          "info",
        );
      },
    });

    if (result.cancelled) {
      return "New session cancelled.";
    }
  } catch (error) {
    return `Handoff failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (currentSessionFile) {
    clearPendingPreparedHandoff(currentSessionFile);
  }

  return undefined;
}

export interface ParsedHandoffFileArgs {
  goal: string;
  summarize: boolean;
}

export function getHandoffFileUsage(): string {
  return "Usage: /handoff:file [-no-summarize] [goal]";
}

export function parseHandoffFileArgs(args: string): ParsedHandoffFileArgs {
  let remaining = args.trim();
  let summarize = true;

  const noSummarizeMatch = remaining.match(/(?:^|\s)-no-summarize(?=\s|$)/u);
  if (noSummarizeMatch) {
    summarize = false;
    remaining = remaining.replace(noSummarizeMatch[0], " ");
  }

  const goal = stripMatchingQuotes(remaining.trim());
  return { goal, summarize };
}

function buildHandoffDocument(
  goal: string,
  parentSession: string | undefined,
  body: string,
): string {
  const sections = [
    "# Handoff Document",
    "",
    `**Created:** ${new Date().toISOString()}`,
  ];
  if (parentSession) {
    sections.push(`**Parent session:** \`${parentSession}\``);
  }
  sections.push(
    `**Goal:** ${goal || "(not specified)"}`,
    "",
    "---",
    "",
    body.trim(),
    "",
  );
  return sections.join("\n");
}

export async function runHandoffFileCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: ParsedHandoffFileArgs,
): Promise<string | undefined> {
  void pi;
  const currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  const messages = collectConversationMessages(ctx.sessionManager.getBranch());

  let body: string;
  if (args.summarize && messages.length > 0) {
    if (!ctx.hasUI) {
      return "handoff:file with summarization requires interactive mode (use -no-summarize otherwise).";
    }
    const summaryModel = await resolveSummaryModelChoice(ctx);
    if (!summaryModel) {
      return "Handoff cancelled.";
    }
    const summary = await generateContextSummaryWithUi(
      ctx,
      summaryModel,
      messages,
      args.goal,
    );
    if (summary === null) {
      return "Handoff cancelled.";
    }
    body = summary;
  } else {
    body = buildDeterministicPrompt(args.goal, currentSessionFile);
  }

  const document = buildHandoffDocument(args.goal, currentSessionFile, body);
  const fileName = `handoff-${new Date().toISOString().replace(/[:.]/gu, "-")}.md`;
  const filePath = join(tmpdir(), fileName);
  try {
    writeFileSync(filePath, document, "utf8");
  } catch (error) {
    return `Failed to write handoff file: ${error instanceof Error ? error.message : String(error)}`;
  }

  ctx.ui.notify(`Handoff document written to ${filePath}`, "info");
  return undefined;
}

export function buildPlanExecutionGoal(planPath: string): string {
  return [
    `Execute work described in approved plan at ${planPath}.`,
    "",
    "Requirements:",
    "- Read the full plan before making changes.",
    "- Register the plan as tracked pi-tasks: one pi-task per top-level plan task plus final verification gates.",
    "- Treat waves as labels; derive runnable work from the dependency graph.",
    "- For each runnable set, launch each independent runnable task through a separate background Agent call when it has no named dependency or file/path conflict.",
    "- If running fewer than all runnable tasks, record the specific dependency or file/path conflict that forced serialization.",
    "- Re-read relevant files from current repo state before changing anything.",
    "- For each task, identify files to change, expected behavior, and verification.",
    "- Verify each completed pi-task yourself before checking off PLAN.md; pi-task completed is not proof.",
    "- Continue until every normal task is verified and every Final Verification Wave verdict is APPROVE, or until truly blocked.",
  ].join("\n");
}

function getPendingPreparedHandoffsGlobal(): PendingPreparedHandoffsGlobal {
  const existing = (globalThis as Record<PropertyKey, unknown>)[
    PENDING_PREPARED_HANDOFFS_GLOBAL_KEY
  ];
  if (existing instanceof Map) {
    return existing as PendingPreparedHandoffsGlobal;
  }

  const prepared = new Map<string, PendingPreparedHandoff>();
  (globalThis as Record<PropertyKey, unknown>)[
    PENDING_PREPARED_HANDOFFS_GLOBAL_KEY
  ] = prepared;
  return prepared;
}

function getPendingPreparedHandoff(
  sessionFile: string,
): PendingPreparedHandoff | null {
  return getPendingPreparedHandoffsGlobal().get(sessionFile) ?? null;
}

function setPendingPreparedHandoff(pending: PendingPreparedHandoff): void {
  getPendingPreparedHandoffsGlobal().set(pending.sessionFile, pending);
}

function clearPendingPreparedHandoff(sessionFile: string): void {
  const prepared = getPendingPreparedHandoffsGlobal();
  prepared.delete(sessionFile);
  if (prepared.size === 0) {
    delete (globalThis as Record<PropertyKey, unknown>)[
      PENDING_PREPARED_HANDOFFS_GLOBAL_KEY
    ];
  }
}

function normalizeDirectHandoffBridgeRequest(
  request?: DirectHandoffBridgeRequest,
): PendingPreparedHandoff {
  if (!request) {
    throw new Error("Missing handoff bridge request.");
  }

  const sessionFile =
    typeof request.sessionFile === "string" ? request.sessionFile.trim() : "";
  if (!sessionFile) {
    throw new Error("Missing handoff bridge session file.");
  }

  const goal = stripMatchingQuotes(
    typeof request.goal === "string" ? request.goal.trim() : "",
  );
  if (!goal) {
    throw new Error("Missing handoff goal.");
  }

  const mode = resolveMode(request.mode);
  if (!mode) {
    throw new Error(
      `Unknown mode: "${String(request.mode)}". Available: ${HANDOFF_MODES.join(", ")}`,
    );
  }

  if (typeof request.summarize !== "boolean") {
    throw new Error("Handoff summarize must be boolean.");
  }

  const source =
    typeof request.source === "string"
      ? request.source.trim() || undefined
      : undefined;
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
      return typeof parsed === "string"
        ? parsed.trim()
        : value.slice(1, -1).trim();
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
  return (
    HANDOFF_MODE_ALIASES[normalized] ??
    (HANDOFF_MODES.includes(normalized as HandoffMode)
      ? (normalized as HandoffMode)
      : null)
  );
}

function collectConversationMessages(
  entries: SessionEntry[],
): Array<SessionEntry & { type: "message" }> {
  return entries.filter(
    (entry): entry is SessionEntry & { type: "message" } =>
      entry.type === "message",
  );
}

async function resolveSummaryModelChoice(
  ctx: ExtensionContext,
): Promise<SummaryModelChoice | null> {
  const currentModelValue = getCurrentModelValue(ctx);
  const remembered = loadHandoffConfig().lastSummaryModel;
  const models = collectSummaryModels(ctx);
  const preferred =
    findAvailableModelChoice(remembered, models) ??
    findAvailableModelChoice(currentModelValue, models);

  if (preferred) {
    return preferred;
  }

  if (models.length === 0) {
    throw new Error("No summary model is available.");
  }

  const selectedValue = await ctx.ui.select(
    "Summary model",
    models.map(({ value }) => value),
  );
  if (!selectedValue) {
    return null;
  }

  const selected = models.find((entry) => entry.value === selectedValue);
  if (!selected) {
    throw new Error(`Unknown summary model selection: ${selectedValue}`);
  }

  return selected;
}

function findAvailableModelChoice(
  value: string | null | undefined,
  models: SummaryModelChoice[],
): SummaryModelChoice | undefined {
  if (!value) {
    return undefined;
  }
  return models.find((entry) => entry.value === value);
}

function collectSummaryModels(ctx: ExtensionContext): SummaryModelChoice[] {
  const seen = new Set<string>();
  const models: SummaryModelChoice[] = [];

  const add = (model: any) => {
    if (
      !model ||
      typeof model.provider !== "string" ||
      typeof model.id !== "string"
    ) {
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
  if (
    !ctx.model ||
    typeof ctx.model.provider !== "string" ||
    typeof ctx.model.id !== "string"
  ) {
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
  return await ctx.ui.custom<string | null>(
    (
      tui: any,
      theme: any,
      _keybindings: any,
      done: (value: string | null) => void,
    ) => {
      const loader = new BorderedLoader(
        tui,
        theme,
        `Generating handoff prompt with ${summaryModel.value}...`,
      );
      loader.onAbort = () => done(null);

      const run = async () => {
        try {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
            summaryModel.model,
          );
          if ("error" in auth) {
            throw new Error(
              auth.error || `No auth available for ${summaryModel.value}`,
            );
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
    },
  );
}

async function generateContextSummary(
  model: any,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  messages: Array<SessionEntry & { type: "message" }>,
  goal: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const conversationText = serializeConversation(
    convertToLlm(messages.map((entry) => entry.message)),
  );
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
    .filter(
      (block: any): block is { type: "text"; text: string } =>
        block.type === "text",
    )
    .map((block: { text: string }) => block.text)
    .join("\n")
    .trim();
}

function buildSummarizedPrompt(
  goal: string,
  parentSession: string | undefined,
  summary: string,
): string {
  const sections = [goal, ""];
  if (parentSession) {
    sections.push(`**Parent session:** \`${parentSession}\``, "");
  }
  sections.push(summary.trim());
  return sections.join("\n");
}

function buildDeterministicPrompt(
  goal: string,
  parentSession: string | undefined,
): string {
  const sections = ["## Goal", goal];

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

function seedChildSessionMode(
  sessionManager: SetupSessionManager,
  mode: HandoffMode,
): void {
  sessionManager.appendCustomEntry?.("agent-mode", {
    mode,
  } satisfies HandoffModeState);
}
