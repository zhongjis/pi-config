import { randomUUID } from "crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
  HANDOFF_CLEAR_CHANNEL,
  HANDOFF_EXECUTION_KICKOFF_EVENT,
  HANDOFF_GET_CHANNEL,
  HANDOFF_MARK_CONSUMED_CHANNEL,
  HANDOFF_PING_CHANNEL,
  HANDOFF_PREPARE_CHANNEL,
  HANDOFF_READY_EVENT,
  createBootstrappingReadiness,
  createErrorReply,
  createExecutionKickoffEvent,
  createHandlersUnwiredReadiness,
  createPingData,
  createReadyEvent,
  createReplyChannel,
  createSuccessReply,
  parseExecutionKickoffSentinel,
} from "./protocol.js";
import {
  clearHandoffArtifacts,
  createHandoffAuthorityRecord,
  markHandoffConsumed,
  readHandoffState,
  readPlanSnapshot,
  writeHandoffAuthority,
  writeHandoffBriefing,
  writePlanSnapshot,
  type HandoffStorageContext,
} from "./storage.js";
import type {
  HandoffClearRequest,
  HandoffExecutionKickoffEvent,
  HandoffGetRequest,
  HandoffMarkConsumedRequest,
  HandoffPreparePayload,
  HandoffPrepareRequest,
  HandoffReadiness,
  HandoffRequestEnvelope,
  PlanAuthoritySnapshot,
} from "./types.js";
import {
  LOCAL_HANDOFF_AUTHORITY_URI,
  LOCAL_HANDOFF_BRIEFING_URI,
  LOCAL_PLAN_URI,
} from "./types.js";

interface RpcError extends Error {
  code?: string;
  readiness?: HandoffReadiness;
}

const HANDOFF_COMMAND_PRODUCER_MODE = "handoff-command";
const HANDOFF_COMMAND_TARGET_MODE = "child-session";
const HANDOFF_CONTEXT_LINE_LIMIT = 6;
const HANDOFF_FILE_REFERENCE_LIMIT = 8;
const HANDOFF_TEXT_LIMIT = 280;
const FILE_REFERENCE_PATTERN = /\b(?:local:\/\/[A-Za-z0-9._/-]+|(?:\.{1,2}\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)\b/gu;

function createRpcError(message: string, options: { code?: string; readiness?: HandoffReadiness } = {}): RpcError {
  const error = new Error(message) as RpcError;
  error.code = options.code;
  error.readiness = options.readiness;
  return error;
}

function hasRequestId(value: unknown): value is { requestId: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { requestId?: unknown }).requestId === "string" &&
      (value as { requestId: string }).requestId.length > 0,
  );
}

function asEnvelope<TPayload>(value: unknown): HandoffRequestEnvelope<TPayload> {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid handoff RPC request: expected an object envelope.");
  }

  return value as HandoffRequestEnvelope<TPayload>;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid handoff RPC request: ${field} must be a non-empty string.`);
  }

  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid handoff RPC request: ${field} must be a non-empty string when present.`);
  }

  return value;
}

function parsePreparePayload(payload: unknown): HandoffPreparePayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid handoff RPC request: prepare payload must be an object.");
  }

  const record = payload as Record<string, unknown>;
  return {
    handoffId: readRequiredString(record.handoffId, "payload.handoffId"),
    briefing: typeof record.briefing === "string" ? record.briefing : (() => {
      throw new Error("Invalid handoff RPC request: payload.briefing must be a string.");
    })(),
    producerMode: readRequiredString(record.producerMode, "payload.producerMode"),
    targetMode: readRequiredString(record.targetMode, "payload.targetMode"),
    kickoffPrompt: readRequiredString(record.kickoffPrompt, "payload.kickoffPrompt"),
    createdAt: readOptionalString(record.createdAt, "payload.createdAt"),
  };
}

function parseMarkConsumedRequest(raw: unknown): HandoffMarkConsumedRequest {
  const request = asEnvelope<Record<string, unknown> | undefined>(raw);
  const payload = request.payload;

  if (payload !== undefined && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
    throw new Error("Invalid handoff RPC request: mark-consumed payload must be an object when present.");
  }

  return {
    ...request,
    payload: {
      consumedAt: readOptionalString((payload as Record<string, unknown> | undefined)?.consumedAt, "payload.consumedAt"),
    },
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateText(value: string, limit = HANDOFF_TEXT_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return normalizeText(content);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const text = content
    .filter((block): block is { type: string; text?: unknown } => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");

  return normalizeText(text);
}

function collectConversationContext(entries: SessionEntry[]): string[] {
  const recentLines: string[] = [];
  let summaryLine: string | undefined;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (!summaryLine && (entry.type === "branch_summary" || entry.type === "compaction")) {
      const summary = normalizeText(entry.summary);
      if (summary) {
        summaryLine = `Summary: ${truncateText(summary)}`;
      }
    }

    if (entry.type !== "message") {
      continue;
    }

    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const text = extractMessageText(entry.message.content);
    if (!text) {
      continue;
    }

    recentLines.push(`${role === "user" ? "User" : "Assistant"}: ${truncateText(text)}`);
    if (recentLines.length >= HANDOFF_CONTEXT_LINE_LIMIT) {
      break;
    }
  }

  const context: string[] = [];
  if (summaryLine) {
    context.push(summaryLine);
  }

  return context.concat(recentLines.reverse());
}

function collectFileReferences(entries: SessionEntry[], plan: PlanAuthoritySnapshot): string[] {
  const files = new Set<string>();

  const collectFromText = (text: string) => {
    for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
      const candidate = match[0].replace(/^[('"`]+|[)'"`.,:;]+$/gu, "");
      if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) {
        continue;
      }

      files.add(candidate);
      if (files.size >= HANDOFF_FILE_REFERENCE_LIMIT) {
        break;
      }
    }
  };

  files.add(plan.uri);
  collectFromText(plan.content);

  for (const entry of entries) {
    if (files.size >= HANDOFF_FILE_REFERENCE_LIMIT) {
      break;
    }

    if (entry.type === "message") {
      const message = entry.message as { content?: unknown } | undefined;
      if (message && "content" in message) {
        collectFromText(extractMessageText(message.content));
      }
      continue;
    }

    if (entry.type === "branch_summary" || entry.type === "compaction") {
      collectFromText(entry.summary);
    }
  }

  return Array.from(files).slice(0, HANDOFF_FILE_REFERENCE_LIMIT);
}

function buildHandoffPrompt(options: {
  cwd: string;
  goal: string;
  plan: PlanAuthoritySnapshot;
  conversationContext: string[];
  files: string[];
}): string {
  const sections = [
    "Continue this work in a new child session.",
    "",
    "## Goal",
    options.goal,
    "",
    "## Context",
    `- Working directory: ${options.cwd}`,
    `- Plan: ${options.plan.planTitle ?? options.plan.uri}`,
    `- Plan reference: ${options.plan.uri}`,
  ];

  if (options.conversationContext.length > 0) {
    sections.push("", "## Conversation context", ...options.conversationContext.map((line) => `- ${line}`));
  }

  if (options.files.length > 0) {
    sections.push("", "## Likely relevant files", ...options.files.map((file) => `- ${file}`));
  }

  sections.push(
    "",
    "## Task",
    options.goal,
    "",
    "Start from the current repo state. Re-read the relevant files and verify assumptions against the latest code before changing anything.",
  );

  return sections.join("\n");
}

async function persistPreparedHandoff(
  ctx: HandoffStorageContext,
  payload: HandoffPreparePayload,
  plan: PlanAuthoritySnapshot,
) {
  await writePlanSnapshot(ctx, plan.content);
  const briefingPath = await writeHandoffBriefing(ctx, payload.briefing);
  const authority = createHandoffAuthorityRecord({
    handoffId: payload.handoffId,
    planHash: plan.planHash,
    planTitle: plan.planTitle,
    producerMode: payload.producerMode,
    targetMode: payload.targetMode,
    kickoffPrompt: payload.kickoffPrompt,
    createdAt: payload.createdAt,
  });
  const authorityPath = await writeHandoffAuthority(ctx, authority);
  const state = await readHandoffState(ctx);

  return {
    authority,
    briefingPath,
    authorityPath,
    readiness: state.readiness,
  };
}

type ExecutionKickoffValidation =
  | { ok: true; prompt: string }
  | { ok: false; reason: string };

function buildInvalidKickoffNotification(reason: string): string {
  return `${reason} Switched back to Fu Xi. Rerun Execute from the latest saved plan.`;
}

async function validateExecutionKickoff(
  ctx: HandoffStorageContext,
  handoffId: string,
  expectedTargetMode = "houtu",
): Promise<ExecutionKickoffValidation> {
  const state = await readHandoffState(ctx);
  const authority = state.authority;

  if (!authority) {
    return {
      ok: false,
      reason: `${LOCAL_HANDOFF_AUTHORITY_URI} is missing for execution handoff ${handoffId}.`,
    };
  }

  if (authority.handoffId !== handoffId) {
    return {
      ok: false,
      reason: `Execution handoff ${handoffId} no longer matches the current pending handoff.`,
    };
  }

  if (authority.targetMode !== expectedTargetMode) {
    return {
      ok: false,
      reason: `Execution handoff ${handoffId} targets ${authority.targetMode}, not ${expectedTargetMode}.`,
    };
  }

  if (authority.status !== "pending") {
    return {
      ok: false,
      reason: state.readiness.reason ?? `Execution handoff ${handoffId} is ${authority.status}.`,
    };
  }

  if (!state.plan) {
    return {
      ok: false,
      reason: state.readiness.reason ?? `${LOCAL_PLAN_URI} is missing.`,
    };
  }

  if (state.freshness?.isStale) {
    return {
      ok: false,
      reason: state.readiness.reason ?? `Execution handoff ${handoffId} is stale against ${LOCAL_PLAN_URI}.`,
    };
  }

  const briefing = state.briefing?.trim();
  if (!briefing) {
    return {
      ok: false,
      reason: state.readiness.reason ?? `${LOCAL_HANDOFF_BRIEFING_URI} is missing for execution handoff ${handoffId}.`,
    };
  }

  return { ok: true, prompt: briefing };
}

export default function (pi: ExtensionAPI) {
  let sessionCtx: HandoffStorageContext | undefined;
  let handlersReady = false;
  let shutDown = false;
  const eventUnsubscribers: Array<() => void> = [];

  const addEventHandler = (channel: string, handler: (raw: unknown) => Promise<void> | void) => {
    eventUnsubscribers.push(pi.events.on(channel, handler));
  };

  const getStartupReadiness = () => {
    if (!handlersReady || shutDown) {
      return createHandlersUnwiredReadiness();
    }

    if (!sessionCtx) {
      return createBootstrappingReadiness();
    }

    return undefined;
  };

  const getReadiness = async (): Promise<HandoffReadiness> => {
    const startupReadiness = getStartupReadiness();
    if (startupReadiness) {
      return startupReadiness;
    }

    return (await readHandoffState(sessionCtx!)).readiness;
  };

  const emitReady = async () => {
    if (shutDown) {
      return;
    }

    pi.events.emit(HANDOFF_READY_EVENT, createReadyEvent(await getReadiness()));
  };


  const replySuccess = <T>(channel: string, requestId: string, data?: T) => {
    pi.events.emit(createReplyChannel(channel, requestId), createSuccessReply(data));
  };

  const replyError = async (channel: string, requestId: string, error: unknown) => {
    const rpcError = error as Partial<RpcError>;
    pi.events.emit(
      createReplyChannel(channel, requestId),
      createErrorReply(error, {
        code: typeof rpcError.code === "string" ? rpcError.code : undefined,
        readiness: rpcError.readiness,
      }),
    );
  };

  const requireSessionCtx = (): HandoffStorageContext => {
    const startupReadiness = getStartupReadiness();
    if (startupReadiness) {
      throw createRpcError(startupReadiness.reason ?? "Handoff extension is not ready.", {
        code: "E_NOT_READY",
        readiness: startupReadiness,
      });
    }

    return sessionCtx!;
  };

  const emitExecutionKickoff = (event: HandoffExecutionKickoffEvent) => {
    pi.events.emit(HANDOFF_EXECUTION_KICKOFF_EVENT, createExecutionKickoffEvent(event));
  };

  pi.on("input", async (event, ctx) => {
    const handoffId = parseExecutionKickoffSentinel(event.text);
    if (!handoffId) {
      return { action: "continue" as const };
    }

    try {
      const validation = await validateExecutionKickoff(ctx as ExtensionContext & HandoffStorageContext, handoffId);
      if (!validation.ok) {
        emitExecutionKickoff({
          handoffId,
          status: "invalid",
          reason: validation.reason,
        });
        if (ctx.hasUI) {
          ctx.ui.notify(buildInvalidKickoffNotification(validation.reason), "warning");
        }
        return { action: "handled" as const };
      }

      emitExecutionKickoff({
        handoffId,
        status: "accepted",
      });
      return { action: "transform" as const, text: validation.prompt };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emitExecutionKickoff({
        handoffId,
        status: "invalid",
        reason,
      });
      if (ctx.hasUI) {
        ctx.ui.notify(buildInvalidKickoffNotification(reason), "warning");
      }
      return { action: "handled" as const };
    }
  });

  pi.registerCommand("handoff", {
    description: "Create a reviewed handoff in a new child session",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /handoff <goal>", "error");
        return;
      }

      const plan = await readPlanSnapshot(ctx as ExtensionContext & HandoffStorageContext);
      if (!plan) {
        ctx.ui.notify("handoff requires local://PLAN.md in the current session", "error");
        return;
      }

      const branchEntries = ctx.sessionManager.getBranch();
      const conversationContext = collectConversationContext(branchEntries);
      const files = collectFileReferences(branchEntries, plan);
      const generatedPrompt = buildHandoffPrompt({
        cwd: ctx.sessionManager.getCwd(),
        goal,
        plan,
        conversationContext,
        files,
      });

      const reviewedPrompt = await ctx.ui.editor("Review handoff prompt", generatedPrompt);
      if (reviewedPrompt === undefined) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const finalPrompt = reviewedPrompt.trim();
      if (!finalPrompt) {
        ctx.ui.notify("Handoff prompt cannot be empty", "error");
        return;
      }

      const parentSession = ctx.sessionManager.getSessionFile();
      if (!parentSession) {
        ctx.ui.setEditorText(finalPrompt);
        ctx.ui.notify(
          "Handoff draft prepared, but this session cannot create a linked child session yet. Start a new session manually and submit the draft there.",
          "warning",
        );
        return;
      }

      const payload: HandoffPreparePayload = {
        handoffId: randomUUID(),
        briefing: finalPrompt,
        producerMode: HANDOFF_COMMAND_PRODUCER_MODE,
        targetMode: HANDOFF_COMMAND_TARGET_MODE,
        kickoffPrompt: finalPrompt,
      };

      await ctx.waitForIdle();

      let newSessionResult: { cancelled: boolean };
      try {
        newSessionResult = await ctx.newSession({
          parentSession,
          setup: async (sessionManager) => {
            await persistPreparedHandoff({ sessionManager }, payload, plan);
          },
        });
      } catch {
        ctx.ui.setEditorText(finalPrompt);
        ctx.ui.notify(
          "Handoff draft prepared, but automatic session handoff failed. Start a new session manually and submit the draft there.",
          "warning",
        );
        return;
      }

      if (newSessionResult.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
        return;
      }

      ctx.ui.setEditorText(finalPrompt);
      ctx.ui.notify("Handoff ready in a new child session. Submit when ready.", "info");
    },
  });

  const wireRpcHandlers = () => {
    if (eventUnsubscribers.length > 0) {
      handlersReady = true;
      return;
    }

  addEventHandler(HANDOFF_PING_CHANNEL, async (raw: unknown) => {
    if (!hasRequestId(raw)) {
      return;
    }

    const requestId = raw.requestId;

    try {
      replySuccess(HANDOFF_PING_CHANNEL, requestId, createPingData(await getReadiness()));
    } catch (error) {
      await replyError(HANDOFF_PING_CHANNEL, requestId, error);
    }
  });

  addEventHandler(HANDOFF_PREPARE_CHANNEL, async (raw: unknown) => {
    if (!hasRequestId(raw)) {
      return;
    }

    const requestId = raw.requestId;

    try {
      const request = asEnvelope<unknown>(raw) as HandoffPrepareRequest;
      const payload = parsePreparePayload(request.payload);
      const ctx = requireSessionCtx();
      const plan = await readPlanSnapshot(ctx);
      if (!plan) {
        const readiness = (await readHandoffState(ctx)).readiness;
        throw createRpcError(readiness.reason ?? "local://PLAN.md is missing.", {
          code: "E_PLAN_MISSING",
          readiness,
        });
      }

      const result = await persistPreparedHandoff(ctx, payload, plan);
      await emitReady();
      replySuccess(HANDOFF_PREPARE_CHANNEL, requestId, result);
    } catch (error) {
      await replyError(HANDOFF_PREPARE_CHANNEL, requestId, error);
    }
  });

  addEventHandler(HANDOFF_GET_CHANNEL, async (raw: unknown) => {
    if (!hasRequestId(raw)) {
      return;
    }

    const requestId = raw.requestId;

    try {
      asEnvelope<HandoffGetRequest["payload"]>(raw);
      const startupReadiness = getStartupReadiness();
      if (startupReadiness) {
        replySuccess(HANDOFF_GET_CHANNEL, requestId, {
          readiness: startupReadiness,
        });
        return;
      }

      const state = await readHandoffState(sessionCtx!);
      replySuccess(HANDOFF_GET_CHANNEL, requestId, {
        authority: state.authority,
        briefing: state.briefing,
        readiness: state.readiness,
      });
    } catch (error) {
      await replyError(HANDOFF_GET_CHANNEL, requestId, error);
    }
  });

  addEventHandler(HANDOFF_MARK_CONSUMED_CHANNEL, async (raw: unknown) => {
    if (!hasRequestId(raw)) {
      return;
    }

    const requestId = raw.requestId;

    try {
      const request = parseMarkConsumedRequest(raw);
      const ctx = requireSessionCtx();
      const authority = await markHandoffConsumed(ctx, request.payload ?? {});
      const state = await readHandoffState(ctx);
      await emitReady();

      replySuccess(HANDOFF_MARK_CONSUMED_CHANNEL, requestId, {
        authority,
        readiness: state.readiness,
      });
    } catch (error) {
      await replyError(HANDOFF_MARK_CONSUMED_CHANNEL, requestId, error);
    }
  });

  addEventHandler(HANDOFF_CLEAR_CHANNEL, async (raw: unknown) => {
    if (!hasRequestId(raw)) {
      return;
    }

    const requestId = raw.requestId;

    try {
      asEnvelope<HandoffClearRequest["payload"]>(raw);
      const ctx = requireSessionCtx();
      await clearHandoffArtifacts(ctx);
      const state = await readHandoffState(ctx);
      await emitReady();
      replySuccess(HANDOFF_CLEAR_CHANNEL, requestId, {
        readiness: state.readiness,
      });
    } catch (error) {
      await replyError(HANDOFF_CLEAR_CHANNEL, requestId, error);
    }
  });

    handlersReady = true;
  };

  wireRpcHandlers();
  void emitReady();

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    sessionCtx = ctx as ExtensionContext & HandoffStorageContext;
    shutDown = false;
    wireRpcHandlers();
    await emitReady();
  });

  pi.on("session_shutdown", async () => {
    shutDown = true;
    handlersReady = false;
    sessionCtx = undefined;

    for (const unsubscribe of eventUnsubscribers.splice(0)) {
      unsubscribe();
    }
  });
}
