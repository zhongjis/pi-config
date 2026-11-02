import { type AgentToolResult, type AgentToolUpdateCallback, defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isTui } from "../../lib/mode.js";
import { createAgentResultBuilder } from "./agent-result.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { renderAgentToolCall, renderAgentToolResult } from "./tool-rendering.js";
import type { AgentRecord } from "./types.js";
import { type AgentDetails, formatMs, getDisplayName } from "./ui/agent-format.js";

interface PresentationSnapshot {
  readonly finished?: boolean;
  readonly error?: string;
  readonly aborted?: boolean;
}

const nativeStatus = {
  queued: "running", running: "running", background: "running",
  completed: "completed", force_steered: "completed",
  error: "error", stopped: "aborted", aborted: "aborted",
} as const satisfies Record<AgentDetails["status"], "running" | "completed" | "error" | "aborted">;

/** T3's example-subagent wire shape, derived from the same report as terminal rows. */
export function projectNativeResult(details: AgentDetails, snapshot: PresentationSnapshot = {}) {
  const state = nativeStatus[details.status];
  const aborted = snapshot.aborted || state === "aborted";
  const failed = !!snapshot.error || state === "error";
  const continuing = snapshot.finished && state === "running";
  const finished = !!snapshot.finished;
  const error = aborted ? snapshot.error || details.error || "Agent execution interrupted" : snapshot.error || details.error;
  const text = finished
    ? aborted || failed ? error || "Agent execution failed" : continuing ? `continues in background as ${details.agentId}` : details.result || "No output."
    : `${details.activity || "starting…"}${details.result ? `\n${details.result.slice(-2000)}` : ""}`;
  return {
    agent: details.displayName, task: details.description, step: 0, model: details.modelName, finished,
    ...(finished ? aborted ? { stopReason: "aborted" as const, errorMessage: error }
      : failed ? { exitCode: 1, stopReason: "error" as const, errorMessage: error || "Agent execution failed" }
      : { exitCode: 0 } : {}),
    messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text: text.slice(0, 10_000) }] }],
  };
}

function progressText(details: AgentDetails): string {
  const line = [details.displayName, details.modelName || "model pending", formatMs(details.durationMs), `${details.toolUses} tool uses`, details.activity || "starting…"].join(" · ");
  return `${line.replace(/\s+/g, " ")}${details.result ? `\n${details.result.slice(-200).replace(/\s+/g, " ")}` : ""}`;
}

type PresentationResult = ReturnType<typeof presentationResult>;
function presentationResult(details: AgentDetails, snapshot?: PresentationSnapshot) {
  const entry = projectNativeResult(details, snapshot);
  return { content: [{ type: "text" as const, text: entry.messages[0].content[0].text }], details: { results: [entry] } };
}

interface Channel {
  current: PresentationResult;
  update?: (result: PresentationResult) => void;
  readonly done: Promise<PresentationResult>;
  readonly finish: (result: PresentationResult) => void;
}

interface PresentingCall {
  readonly id: string;
  readonly ctx: ExtensionToolContext;
  readonly signal?: AbortSignal;
  readonly enabled: boolean;
  readonly type: string;
  readonly description: string;
  readonly record: () => AgentRecord | undefined;
  readonly onUpdate?: AgentToolUpdateCallback<AgentDetails | undefined>;
}

/** Activation-owned channels; presentation never owns or cancels an Execution. */
export function createNativePresentation(pi: ExtensionAPI) {
  const channels = new Map<string, Channel>();
  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.PRESENTATION,
    label: "Subagent",
    description: "Internal subagent presentation channel.",
    exposure: "deferred",
    parameters: Type.Object({}),
    renderCall: renderAgentToolCall,
    renderResult: renderAgentToolResult,
    execute: async (id, _params, _signal, onUpdate) => {
      const channel = channels.get(id);
      if (!channel) return { content: [{ type: "text", text: "No live subagent presentation channel." }], details: undefined, isError: true };
      channel.update = onUpdate;
      onUpdate?.(channel.current);
      return channel.done;
    },
  }));
  const buildDetails = createAgentResultBuilder(() => false);
  return async function present<T extends { content: AgentToolResult<unknown>["content"]; details: Partial<AgentDetails> | undefined; isError?: boolean }>(call: PresentingCall, execute: (update?: AgentToolUpdateCallback<AgentDetails | undefined>) => Promise<T>): Promise<T> {
    if (!call.enabled || isTui(call.ctx) || !call.ctx.hasUI) return execute(call.onUpdate);
    const base = { displayName: getDisplayName(call.type), description: call.description, subagentType: call.type };
    const initial: AgentDetails = { ...base, toolUses: 0, tokens: "", durationMs: 0, status: "running" };
    const read = () => {
      const record = call.record();
      return record ? buildDetails({ ...base, displayName: getDisplayName(record.type), description: record.description }, record, {
        activity: record.activity,
        overrides: { result: record.activity?.responseText || record.result },
      }) : initial;
    };
    let finish: Channel["finish"] = () => {};
    const done = new Promise<PresentationResult>(resolve => { finish = resolve; });
    const channel: Channel = { current: presentationResult(read()), done, finish };
    const nestedId = `${call.id}/1`;
    channels.set(nestedId, channel);
    let lastActivity: string | undefined;
    let lastUpdate = -Infinity;
    const update = () => {
      const details = read();
      const activity = details.activity || "starting…";
      if (activity === lastActivity || Date.now() - lastUpdate < 1000) return;
      lastActivity = activity;
      lastUpdate = Date.now();
      channel.current = presentationResult(details);
      channel.update?.(channel.current);
      call.onUpdate?.({ content: [{ type: "text", text: progressText(details) }], details });
    };
    update();
    // Never let presentation hold or fail the run: a T3 Supervised approval can park the
    // nested call, and a mode or approval block rejects it. The channel outlives the run
    // until the nested call settles, so a late start still renders the final entry.
    const nested = call.ctx.executeTool(SUBAGENT_TOOL_NAMES.PRESENTATION, {}).then(() => undefined, () => undefined);
    const timer = setInterval(update, 1000);
    let result: T | undefined;
    let failure: string | undefined;
    try {
      result = await execute(update);
      return result;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      clearInterval(timer);
      const details = { ...read(), ...result?.details };
      const text = result?.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const error = failure || result?.details?.error || (result?.isError || !result?.details?.status ? text || "Agent execution failed" : undefined);
      const aborted = call.signal?.aborted;
      const reason = aborted ? String(call.signal?.reason || "Agent execution aborted") : error;
      const final = presentationResult(details, { finished: true, error: reason, aborted });
      channel.current = final;
      channel.finish(final);
      void nested.then(() => channels.delete(nestedId));
    }
  };
}

export type NativePresentation = ReturnType<typeof createNativePresentation>;
