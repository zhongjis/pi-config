import { type AgentToolResult, type AgentToolUpdateCallback, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { isTui } from "../../lib/mode.js";
import { createAgentResultBuilder } from "./agent-result.js";
import { getInterruptionLabel } from "./status-note.js";
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
  const error = aborted ? getInterruptionLabel(details.interruptionCause) : snapshot.error || details.error;
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

interface PresentingCall {
  readonly ctx: ExtensionToolContext;
  readonly signal?: AbortSignal;
  readonly enabled: boolean;
  readonly cards?: boolean;
  readonly type: string;
  readonly description: string;
  readonly record: () => AgentRecord | undefined;
  readonly onUpdate?: AgentToolUpdateCallback<AgentDetails | undefined>;
}

/** Direct tool updates; presentation never owns or cancels an Execution. */
export function createNativePresentation() {
  const buildDetails = createAgentResultBuilder(() => false);
  return async function present<T extends { content: AgentToolResult<unknown>["content"]; details: Partial<AgentDetails> | undefined; isError?: boolean }>(call: PresentingCall, execute: (update?: AgentToolUpdateCallback<AgentDetails | undefined>) => Promise<T>) {
    if (!call.enabled || isTui(call.ctx) || !call.ctx.hasUI) return execute(call.onUpdate);
    const cards = call.cards !== false;
    const base = { displayName: getDisplayName(call.type), description: call.description, subagentType: call.type };
    const initial: AgentDetails = { ...base, toolUses: 0, tokens: "", durationMs: 0, status: "running" };
    const read = () => {
      const record = call.record();
      return record ? buildDetails({ ...base, displayName: getDisplayName(record.type), description: record.description }, record, {
        activity: record.activity,
        overrides: { result: record.activity?.responseText || record.result },
      }) : initial;
    };
    let lastActivity: string | undefined;
    let lastUpdate = -Infinity;
    let streamed = false;
    const update = () => {
      const details = read();
      const activity = details.activity || "starting…";
      if (activity === lastActivity || Date.now() - lastUpdate < 1000) return;
      lastActivity = activity;
      lastUpdate = Date.now();
      if (call.onUpdate) {
        call.onUpdate({ content: [{ type: "text", text: progressText(details) }], details: { ...details, ...(cards ? { results: [projectNativeResult(details)] } : {}) } });
        streamed = true;
      }
    };
    update();
    const timer = setInterval(update, 1000);
    let result: T | undefined;
    let failure: string | undefined;
    let final: ReturnType<typeof projectNativeResult> | undefined;
    try {
      result = await execute(update);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      clearInterval(timer);
      if (cards) {
        const details = { ...read(), ...result?.details };
        const text = result?.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const error = failure || result?.details?.error || (result?.isError || !result?.details?.status ? text || "Agent execution failed" : undefined);
        final = projectNativeResult(details, { finished: true, error, aborted: call.signal?.aborted });
        const finishedDetails = { ...details, results: [final] };
        if (streamed) call.onUpdate?.({ content: [{ type: "text", text: progressText(details) }], details: finishedDetails });
      }
    }
    return final ? { ...result, details: { ...result.details, results: [final] } } : result;
  };
}

export type NativePresentation = ReturnType<typeof createNativePresentation>;
