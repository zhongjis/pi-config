/**
 * node-host-adapter.ts — the real {@link NodeHost} over `AgentManager`.
 *
 * The real {@link NodeHost} over `AgentManager`: it resolves a
 * node's agent type/model, spawns through `AgentManager`, and maps the resulting
 * record back to a {@link NodeSpawnResult}. It implements the graph's node seam,
 * so `run-graph.ts` never touches the manager directly.
 *
 * Cancellation is the caller's `AbortSignal` (the node actor's), combined with an
 * optional run-wide `deps.signal`; there is no per-agent abort handle because a
 * node actor's `stop()` already carries the signal here.
 */

import type { AgentSession, ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { getAgentConfig, resolveType } from "../agent-types.js";
import { prepareAgentInvocation } from "../invocation-config.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry, writeResultEntry } from "../output-file.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { graphRunNodeArtifactId } from "./history-artifact.js";
import type { NodeHost, NodeSpawnRequest, NodeSpawnResult } from "./node-host.js";

export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

export interface NodeHostOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  graphRunId: string;
  /** Run-wide abort, combined with each node actor's own signal. */
  signal?: AbortSignal;
  gateTimeoutMs?: number;
  scopeModels?: () => boolean;
  outputTranscript?: () => boolean;
  nodeIndex?: (nodeId: string) => number | undefined;
}

function toNodeResult(record: AgentRecord): NodeSpawnResult {
  return {
    ok: record.status === "completed" || record.status === "steered",
    output: record.structuredJson ?? record.result ?? "",
    error: record.error,
    skipped: record.status === "stopped",
    ...(record.lifetimeCost !== undefined ? { costUsd: record.lifetimeCost } : {}),
    tokens: getLifetimeTotal(record.lifetimeUsage),
    outputTokens: record.lifetimeUsage.output,
    toolCalls: record.toolUses,
    cwd: record.cwd,
  };
}

export type ManagedNodeHost = NodeHost & { dispose(): Promise<void> };

export function createNodeHost(deps: NodeHostOptions): ManagedNodeHost {
  const { pi, ctx, manager } = deps;
  const owned = new Set<string>();
  const gates = new Set<Promise<ExecResult>>();
  const warned = new Set<string>();
  let disposed = false;

  return {
    // Sessions and UI prompts are process-owned; shell descendants are not.
    async reconcileDrain(_correlation, target) { return !disposed && (target === "agent" || target === "human-gate"); },
    async spawnAgent(request: NodeSpawnRequest, signal: AbortSignal): Promise<NodeSpawnResult> {
      if (disposed) throw new Error("Node host is disposed.");
      const combined = deps.signal ? AbortSignal.any([deps.signal, signal]) : signal;
      let unsubscribeModel: (() => void) | undefined;
      try {
        combined.throwIfAborted();
        const type = resolveType(request.agentType);
        const currentConfig = type === undefined ? undefined : getAgentConfig(type);
        if (type === undefined || !currentConfig || currentConfig.enabled === false) {
          throw new Error(`Graph agent "${request.agentType}" is unavailable in the current configuration.`);
        }
        const params = {};
        const { agentConfig: config, invocation, selectedModel, scope } = prepareAgentInvocation({
          agentType: type,
          params,
          modelRegistry: ctx.modelRegistry,
          parentModel: ctx.model,
          cwd: ctx.cwd,
          scopeModels: deps.scopeModels?.() ?? false,
        });
        if (scope) {
          const message = `Model not in scope: ${scope.model.provider}/${scope.model.id}`;
          if (!warned.has(message)) {
            warned.add(message);
            ctx.ui.notify(message, "warning");
          }
        }
        let spawned: AgentRecord | undefined;
        const index = deps.nodeIndex?.(request.nodeId);
        const artifactId = index === undefined ? undefined : graphRunNodeArtifactId(deps.graphRunId, index);
        let childSession: AgentSession | undefined;
        const streamTranscript = () => {
          if (childSession && spawned?.outputFile && artifactId && !spawned.outputCleanup) {
            spawned.outputCleanup = streamToOutputFile(childSession, spawned.outputFile, artifactId, ctx.cwd);
          }
        };
        const { record } = await manager.spawnAndWait(
          pi,
          ctx,
          type,
          request.prompt,
          {
            description: request.nodeId,
            graphRunId: deps.graphRunId,
            selectedModel,
            model: selectedModel.model,
            thinkingLevel: invocation.thinking,
            maxTurns: invocation.maxTurns,
            isolated: invocation.isolated,
            inheritContext: invocation.inheritContext,
            structuredOutput: request.schema,
            signal: combined,
            invocation: {
              requestedModel: invocation.modelInput,
              requestedThinking: invocation.thinking,
              thinkingDefault: invocation.thinking === undefined,
            },
            onSessionCreated: session => {
              childSession = session;
              // Only events from this spawn are execution evidence; inherited messages
              // and the selected session model do not prove an assistant used it.
              unsubscribeModel = session.subscribe(event => {
                if ((event.type !== "message_start" && event.type !== "message_end") || event.message.role !== "assistant") return;
                const { model, provider } = event.message;
                if (!model) return;
                request.onResolved?.({ modelId: model, modelName: provider ? `${provider}/${model}` : model, thinking: session.thinkingLevel });
              });
              streamTranscript();
            },
          },
          id => {
            owned.add(id);
            spawned = manager.getRecord(id);
            request.onResolved?.({ recordId: id });
            if (spawned && artifactId && (config?.outputTranscript ?? deps.outputTranscript?.() ?? true)) {
              spawned.outputFile = createOutputFilePath(ctx.cwd, artifactId, ctx.sessionManager.getSessionId());
              writeInitialEntry(spawned.outputFile, artifactId, request.prompt, ctx.cwd);
            }
            streamTranscript();
          },
        );
        const result = toNodeResult(record);
        if (record.outputFile && artifactId && result.output) {
          try { writeResultEntry(record.outputFile, artifactId, result.output, ctx.cwd); } catch { /* Transcript failure cannot change graph outcome. */ }
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (combined.aborted) return { ok: false, skipped: true, error: message };
        return { ok: false, error: message };
      } finally {
        unsubscribeModel?.();
      }
    },

    async runGate(command, options) {
      if (disposed) throw new Error("Node host is disposed.");
      const combined =
        deps.signal && options.signal ? AbortSignal.any([deps.signal, options.signal]) : (deps.signal ?? options.signal);
      combined?.throwIfAborted();
      const shell = process.platform === "win32" ? "cmd" : "sh";
      const flag = process.platform === "win32" ? "/c" : "-c";
      const pending = pi.exec(shell, [flag, command], {
        cwd: options.cwd ?? ctx.cwd,
        signal: combined,
        timeout: deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
      });
      gates.add(pending);
      let result: ExecResult;
      try {
        result = await pending;
      } finally {
        gates.delete(pending);
      }
      return {
        ok: !combined?.aborted && !result.killed && result.code === 0,
        output: [result.stdout, result.stderr].filter(Boolean).join("\n") || (result.killed ? "Gate timed out or was cancelled." : ""),
      };
    },

    async awaitHumanGate(request, signal) {
      if (signal.aborted) return { ok: false, skipped: true, error: "Aborted." };
      // ponytail: v1 is approve/reject only, surfaced through ctx.ui.select and
      // producing { approved }; richer typed forms and durable resume across a
      // process restart are the known ceiling (design v2 §1.3 / P4). A human_gate
      // schema should therefore accept { approved: boolean }. ctx.ui.select takes
      // no signal, so a skip of an already-open prompt only settles once the user
      // answers or dismisses it.
      const choice = await ctx.ui.select(request.prompt, ["Approve", "Reject"]);
      if (choice === undefined) return { ok: false, skipped: true, error: "Human gate dismissed." };
      return { ok: true, output: JSON.stringify({ approved: choice === "Approve" }) };
    },

    async dispose() {
      disposed = true;
      for (const id of owned) manager.abort(id);
      await Promise.allSettled([...gates, ...[...owned].map(id => manager.getRecord(id)?.promise)]);
      owned.clear();
      warned.clear();
    },
  };
}
