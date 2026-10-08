import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mergeAgentHistory, readHistoryConversation } from "./agent-history.js";
import type { AgentManager } from "./agent-manager.js";
import { formatLifetimeTokens, partialOutputSuffix, textResult } from "./agent-result.js";
import { formatAgentConversation, getAgentConversation, resolveOwnedSessionFile, SUBAGENT_TOOL_NAMES, steerAgent } from "./agent-runner.js";
import { extractText } from "./context.js";
import { isGraphRunId } from "./graph/graph-snapshot-path.js";
import type { createGraphResultObserver } from "./graph/result-observer.js";
import { QUEUE_WAIT_POLL_MS } from "./notification-coordinator.js";
import { getStatusNote } from "./status-note.js";
import { renderGetAgentResult, renderGetAgentResultCall, renderSteerSubagentCall, renderSteerSubagentResult } from "./tool-rendering.js";
import type { AgentRecord, EvictedAgent } from "./types.js";
import { type AgentDetails, formatDuration, getDisplayName } from "./ui/agent-widget.js";
import { getSessionContextPercent } from "./usage.js";

/** Retrieval reads live report state and suppresses held completion delivery. */
interface ResultDelivery {
  readonly details: (record: AgentRecord) => AgentDetails;
  readonly cancelNudge: (id: string, executionId?: string) => void;
}

/** Await a promise until it settles or the caller cancels, without aborting the underlying work. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function createResultTools(pi: ExtensionAPI, manager: AgentManager, delivery: ResultDelivery, graphs: Pick<ReturnType<typeof createGraphResultObserver>, "retrieve">) {
  /** Read-only report of an evicted run from its history entry and transcript; never inserts a record. */
  async function retrieveEvicted(evicted: EvictedAgent, ctx: ExtensionContext, verbose?: boolean) {
    const [record] = mergeAgentHistory([], [evicted]);
    const owned = resolveOwnedSessionFile(ctx, evicted.type, evicted.sessionFile);
    const transcript = owned.ok ? await readHistoryConversation(owned.file) : owned;
    const statsParts = [`Tool uses: ${record.toolUses}`];
    const tokens = formatLifetimeTokens(record);
    if (tokens) statsParts.push(tokens);
    statsParts.push(`Duration: ${formatDuration(record.startedAt, record.completedAt)}`);
    let output =
      `Agent: ${record.id}\n` +
      `Type: ${getDisplayName(record.type)} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
      `Description: ${record.description}\n\n`;
    if (!transcript.ok) {
      output += `Transcript unavailable (${transcript.reason}).`;
      return textResult(output, delivery.details(record));
    }
    const assistants = transcript.messages.filter((message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant");
    const lastText = assistants.map((message) => extractText(message.content).trim()).filter(Boolean).at(-1);
    const errorMessage = record.status === "error" ? assistants.at(-1)?.errorMessage?.trim() : undefined;
    // The tool row renders from details, so the detached record carries the transcript outcome.
    record.result = lastText;
    record.error = errorMessage;
    if (errorMessage) output += `Error: ${errorMessage}\n\n`;
    output += lastText || "No output.";
    const details = delivery.details(record);
    if (verbose) {
      const conversation = formatAgentConversation(transcript.messages);
      details.conversation = conversation;
      if (conversation) output += `\n\n--- Agent Conversation ---\n${conversation}`;
    }
    return textResult(output, details);
  }

  async function retrieveAgent(params: { agent_id: string; wait?: boolean; verbose?: boolean }, ctx: ExtensionContext, signal?: AbortSignal) {
    const record = manager.getRecord(params.agent_id);
    if (!record) {
      const evicted = manager.getEvicted(params.agent_id);
      if (evicted) return retrieveEvicted(evicted, ctx, params.verbose);
      return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
    }

    const executionId = record.executionId;
    // Cancellation stops only this wait, not the background agent or its notification.
    // Queued agents acquire their promise only when the queue starts them.
    if (params.wait) {
      while (record.status === "queued") {
        await abortable(
          new Promise<void>((resolve) => setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
          signal,
        );
      }
      if (record.promise) await abortable(record.promise, signal);
    }

    if (record.executionId !== executionId) {
      return textResult(`Agent "${record.id}" started another execution while this retrieval waited. Retrieve its current result again.`);
    }

    const displayName = getDisplayName(record.type);
    const duration = formatDuration(record.startedAt, record.completedAt);
    const tokens = formatLifetimeTokens(record);
    const contextPercent = getSessionContextPercent(record.session);
    const statsParts = [`Tool uses: ${record.toolUses}`];
    if (tokens) statsParts.push(tokens);
    if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
    if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
    statsParts.push(`Duration: ${duration}`);

    let output =
      `Agent: ${record.id}\n` +
      `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status, record.interruptionCause)} | ${statsParts.join(" | ")}\n` +
      `Description: ${record.description}\n\n`;

    const pending = manager.hasPendingExecution(params.agent_id);
    if (pending) {
      output += "Agent execution is still pending. When no other work remains, call get_agent_result with wait: true; do not resume this agent and do not end your turn.";
      const partial = record.result?.trim();
      if (partial) output += `\n\nRetained partial output:\n${partial}`;
    } else if (record.status === "error") {
      output += `Error: ${record.error}${partialOutputSuffix(record)}`;
    } else {
      output += record.result?.trim() || "No output.";
    }

    if (!pending) {
      record.resultConsumed = true;
      delivery.cancelNudge(params.agent_id, executionId);
    }
    const details = delivery.details(record);
    if (params.verbose && record.session) {
      const conversation = getAgentConversation(record.session);
      details.conversation = conversation;
      if (conversation) output += `\n\n--- Agent Conversation ---\n${conversation}`;
    }
    return textResult(output, details);
  }

  const steer = defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    renderCall(args, theme) {
      return renderSteerSubagentCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderSteerSubagentResult(result, options, theme, context);
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        const evicted = manager.getEvicted(params.agent_id);
        if (evicted) return textResult(`Agent "${params.agent_id}" is not running (status: ${evicted.status}). Cannot steer a non-running agent.`);
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }
      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
  const getAgentResult = defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_AGENT_RESULT,
    label: "Get Agent Result",
    description: "Retrieve a background run. Use wait:true when no non-overlapping work remains; never end the turn or poll while work runs. Cancellation stops only retrieval. Accepts independent agent and agr_* graph run IDs. A graph wait returns on completion or human input: use ask, then resolve_agent_graph_gate.",
    promptSnippet: "Collect background results; wait instead of polling",
    renderCall: renderGetAgentResultCall,
    renderResult: renderGetAgentResult,
    parameters: Type.Object({
      run_id: Type.String({ description: "Independent agent ID or agr_* graph run ID." }),
      wait: Type.Optional(Type.Boolean({ description: "Wait for completion or actionable human input. Cancellation stops only this wait." })),
      verbose: Type.Optional(Type.Boolean({ description: "Include an independent agent's conversation." })),
    }),
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      if (isGraphRunId(params.run_id)) return graphs.retrieve(params.run_id, params.wait === true, signal);
      const result = await retrieveAgent({ agent_id: params.run_id, wait: params.wait, verbose: params.verbose }, ctx, signal);
      const details = result.details;
      return { ...result, details: { ...(details && typeof details === "object" ? details : {}), kind: "agent" as const, run_id: params.run_id } };
    },
  });
  return { getAgentResult, steer };
}
