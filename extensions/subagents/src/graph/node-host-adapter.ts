/**
 * node-host-adapter.ts — the real {@link NodeHost} over `AgentManager`.
 *
 * The real {@link NodeHost} over `AgentManager`: it resolves a
 * node's agent type/model, spawns through `AgentManager`, and maps the resulting
 * record back to a {@link NodeSpawnResult}. It also runs decision_gate model
 * chains. It implements the graph's node seam,
 * so `run-graph.ts` never touches the manager directly.
 *
 * Cancellation is the caller's `AbortSignal` (the node actor's), combined with an
 * optional run-wide `deps.signal`; there is no per-agent abort handle because a
 * node actor's `stop()` already carries the signal here.
 */

import type { AgentSession, ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertFastSupported } from "../../../lib/fast.js";
import { type ModelCandidate, resolveModel } from "../../../lib/model-selection.js";
import { resolveToolModelChain } from "../../../lib/tool-models.js";
import type { AgentManager } from "../agent-manager.js";
import { getAgentConfig, resolveType } from "../agent-types.js";
import { loadGraphClassifierAgent } from "../builtin-agents.js";
import { prepareAgentInvocation } from "../invocation-config.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry, writeResultEntry } from "../output-file.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { agentAnswerSchema, compileDerivedSchema, normalizeAgentAnswers, normalizeClassifierAnswers } from "./decision-gate.js";
import { graphRunNodeArtifactId } from "./history-artifact.js";
import type { DecisionRequest, DecisionResult, NodeHost, NodeResolvedInfo, NodeSpawnRequest, NodeSpawnResult } from "./node-host.js";

export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;
const DECISION_MODELS_KEY = "subagents.decision_gate";
const MAX_DECISION_ERROR = 1500;

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
  awaitEscalation?: NodeHost["awaitEscalation"];
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

/** Only assistant messages from this spawn are execution evidence of its model. */
function forwardModel(session: AgentSession, onResolved: ((info: NodeResolvedInfo) => void) | undefined): () => void {
  return session.subscribe(event => {
    if ((event.type !== "message_start" && event.type !== "message_end") || event.message.role !== "assistant") return;
    const { model, provider } = event.message;
    if (!model) return;
    onResolved?.({ modelId: model, modelName: provider ? `${provider}/${model}` : model, thinking: session.thinkingLevel });
  });
}

function entryLabel(entry: ModelCandidate): string {
  return `${entry.model}${entry.thinkingLevel ? `:${entry.thinkingLevel}` : ""}${entry.fast ? ":fast" : ""}`;
}

function decisionPrompt(request: DecisionRequest): string {
  return [
    "Answer every question below from the supplied state in one StructuredOutput call.",
    "", "Questions:", JSON.stringify(request.questions, null, 2),
    "", "State:", JSON.stringify(request.state, null, 2),
  ].join("\n");
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
    async reconcileDrain(_correlation, target) { return !disposed && (target === "agent" || target === "escalation"); },
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
              // Inherited messages and the selected session model do not prove an assistant used it.
              unsubscribeModel = forwardModel(session, request.onResolved);
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

    /**
     * Walk the written `subagents.decision_gate` chain: a registered classifier
     * classifies; any other authenticated chat entry runs the internal agent
     * fallback on exactly that model. The first valid answer decides; failures advance.
     */
    async decide(request, signal): Promise<DecisionResult> {
      if (disposed) throw new Error("Node host is disposed.");
      const combined = deps.signal ? AbortSignal.any([deps.signal, signal]) : signal;
      const { entries } = resolveToolModelChain(ctx.cwd, DECISION_MODELS_KEY);
      if (entries.length === 0) return { ok: false, error: `No decision models configured (tool_models key ${DECISION_MODELS_KEY})`, costUsd: 0 };
      const registry = ctx.modelRegistry;
      const failures: string[] = [];
      // Any attempted entry with unknown cost makes the whole decision's cost unknown.
      let total: number | undefined = 0;
      const spend = (cost: number | undefined) => { total = total === undefined || cost === undefined ? undefined : total + cost; };
      const priced = () => total === undefined ? {} : { costUsd: total };
      const skipped = (): DecisionResult => ({ ok: false, skipped: true, error: "Aborted.", ...priced() });
      // Catalog classifiers resolve without credentials; availability is checked once per provider per decision.
      const availableClassifiers = new Map<string, Promise<readonly { readonly id: string }[]>>();
      for (const entry of entries) {
        if (combined.aborted || disposed) return skipped();
        const label = entryLabel(entry);
        const slash = entry.model.indexOf("/");
        const provider = slash > 0 ? entry.model.slice(0, slash) : undefined;
        const id = entry.model.slice(slash + 1);
        let unsubscribeModel: (() => void) | undefined;
        try {
          const classifier = provider ? registry.findOfType("classifier", provider, id) : undefined;
          if (classifier && provider) {
            const available = availableClassifiers.get(provider) ?? registry.getAvailableOfType("classifier", provider);
            availableClassifiers.set(provider, available);
            if (!(await available).some(model => model.id === id)) {
              failures.push(`${label}: unavailable`);
              continue;
            }
            // classify never rejects; state round-trips as the JSON it already is.
            const result = await registry.classify(classifier, { state: JSON.parse(JSON.stringify(request.state)), questions: request.questions }, { signal: combined });
            // A failed call without usage reported no spend; an unpriced answer stays unknown.
            spend(result.usage?.cost.total ?? (result.stopReason === "error" ? 0 : undefined));
            if (result.stopReason === "aborted" || combined.aborted) return skipped();
            if (result.stopReason !== "stop") {
              failures.push(`${label}: ${result.errorMessage ?? "classifier error"}`);
              continue;
            }
            const answers = normalizeClassifierAnswers(request.questions, result.answers);
            request.onResolved?.({ modelId: id, modelName: entry.model });
            return { ok: true, answers, decidedBy: "classifier", model: entry.model, ...priced() };
          }
          const resolved = provider ? registry.find(provider, id) : resolveModel(entry.model, registry);
          const model = resolved && typeof resolved !== "string" && (!provider || registry.hasConfiguredAuth(resolved)) ? resolved : undefined;
          if (!model) {
            failures.push(`${label}: unavailable`);
            continue;
          }
          // Validate explicit Fast before child creation; unsupported capability is an entry failure.
          if (entry.fast) assertFastSupported(model, registry.isUsingOAuth(model));
          const { record } = await manager.spawnInternalAndWait(pi, ctx, loadGraphClassifierAgent(), decisionPrompt(request), {
            description: request.nodeId,
            graphRunId: deps.graphRunId,
            model,
            selectedModel: { model, thinkingLevel: entry.thinkingLevel, fast: entry.fast },
            thinkingLevel: entry.thinkingLevel,
            structuredOutput: compileDerivedSchema(agentAnswerSchema(request.questions)),
            signal: combined,
            onSessionCreated: session => { unsubscribeModel = forwardModel(session, request.onResolved); },
          }, spawnedId => {
            owned.add(spawnedId);
            request.onResolved?.({ recordId: spawnedId });
          });
          spend(record.lifetimeCost);
          if (record.status === "stopped" || combined.aborted) return skipped();
          if ((record.status !== "completed" && record.status !== "steered") || record.structuredJson === undefined) {
            failures.push(`${label}: ${record.error ?? `agent ${record.status} without a decision`}`);
            continue;
          }
          const answers = normalizeAgentAnswers(request.questions, JSON.parse(record.structuredJson));
          return { ok: true, answers, decidedBy: "agent", model: `${model.provider}/${model.id}`, ...priced() };
        } catch (error) {
          if (combined.aborted) return skipped();
          failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          unsubscribeModel?.();
        }
      }
      const error = failures.join("; ");
      return { ok: false, error: error.length > MAX_DECISION_ERROR ? `${error.slice(0, MAX_DECISION_ERROR - 1)}…` : error, ...priced() };
    },

    async awaitEscalation(request, signal) {
      if (disposed) throw new Error("Node host is disposed.");
      const combined = deps.signal ? AbortSignal.any([deps.signal, signal]) : signal;
      combined.throwIfAborted();
      if (!deps.awaitEscalation) return { ok: false, error: "Escalation handoff is unavailable." };
      return deps.awaitEscalation(request, combined);
    },

    async dispose() {
      disposed = true;
      for (const id of owned) manager.abort(id, "lifecycle");
      await Promise.allSettled([...gates, ...[...owned].map(id => manager.getRecord(id)?.promise)]);
      owned.clear();
      warned.clear();
    },
  };
}
