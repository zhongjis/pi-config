import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { loadHandoffConfig, updateHandoffConfig } from "./config.js";

export type HandoffMode = "kuafu" | "fuxi" | "houtu";
type HandoffModeState = { mode?: HandoffMode };

type SummaryModelChoice = { value: string; model: any };
type SetupSessionManager = {
  appendCustomEntry?: (customType: string, data?: unknown) => unknown;
};

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

  try {
    await ctx.waitForIdle();
    const result = await ctx.newSession({
      parentSession: currentSessionFile,
      setup: async (sessionManager: SetupSessionManager) => {
        seedChildSessionMode(sessionManager, args.mode);
      },
    });

    if (result.cancelled) {
      return "New session cancelled.";
    }

    pi.sendUserMessage(finalPrompt);
  } catch (error) {
    return `Handoff failed: ${error instanceof Error ? error.message : String(error)}`;
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

function resolveMode(value?: string): HandoffMode | null {
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
