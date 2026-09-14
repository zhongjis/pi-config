/** Local manager adapter for the selectively vendored workflow runtime. */
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { getAgentConfig, resolveType } from "../agent-types.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "../enabled-models.js";
import { resolveAgentInvocationConfig } from "../invocation-config.js";
import { resolveAgentModel } from "../model-resolution.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "../output-file.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import type { WorkflowHost, WorkflowSpawnRequest, WorkflowSpawnResult } from "./runtime.js";
import { resolveWorkflowSource } from "./saved.js";

export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

export interface WorkflowHostOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  workflowId: string;
  signal?: AbortSignal;
  gateTimeoutMs?: number;
  scopeModels?: () => boolean;
  outputTranscript?: () => boolean;
}

function resolvedInfo(record: AgentRecord, report: WorkflowSpawnRequest["onResolved"]): void {
  report?.({ recordId: record.id, ...record.invocation,
    ...(record.session?.model ? { modelId: record.session.model.id } : {}),
  });
}

function toSpawnResult(record: AgentRecord, previous?: { tokens: number; output: number; tools: number }): WorkflowSpawnResult {
  return {
    ok: record.status === "completed" || record.status === "steered",
    text: record.structuredJson ?? record.result ?? "",
    error: record.error,
    skipped: record.status === "stopped",
    tokens: getLifetimeTotal(record.lifetimeUsage) - (previous?.tokens ?? 0),
    outputTokens: record.lifetimeUsage.output - (previous?.output ?? 0),
    toolCalls: record.toolUses - (previous?.tools ?? 0),
    structuredRetried: record.structuredRetried,
    cwd: record.cwd,
  };
}

export function createWorkflowHost(deps: WorkflowHostOptions): WorkflowHost {
  const { pi, ctx, manager } = deps;
  const records = new Map<string, string>();
  const owned = new Set<string>();
  const gates = new Set<Promise<ExecResult>>();
  let disposed = false;
  // Controllers remain until the next attempt or run disposal, including the gate.
  const controllers = new Map<string, AbortController>();
  const warned = new Set<string>();
  function attemptSignal(id: string): AbortSignal {
    if (disposed) throw new Error("Workflow host is disposed.");
    const controller = new AbortController();
    controllers.set(id, controller);
    return deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
  }
  return {
    async dispose() {
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      for (const id of owned) manager.abort(id);
      await Promise.allSettled([...gates, ...[...owned].map(id => manager.getRecord(id)?.promise)]);
      controllers.clear();
      records.clear();
      owned.clear();
      warned.clear();
    },
    async spawnAgent(request) {
      if (Object.hasOwn(request, "isolation")) return { ok: false, error: "Workflow isolation is not supported: no isolation backend is installed." };
      const signal = attemptSignal(request.agentId);
      try {
        signal.throwIfAborted();
        const type = resolveType(request.agentType) ?? "general-purpose";
        const config = getAgentConfig(type);
        const params = { model: request.model, thinking: request.effort };
        const initial = resolveAgentInvocationConfig(config, params);
        const selected = resolveAgentModel(initial.modelInput, ctx.modelRegistry, ctx.model);
        const invocation = resolveAgentInvocationConfig(config, params, selected.thinkingLevel);
        if (deps.scopeModels?.() && selected.model) {
          const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
          if (allowed && !isModelInScope(selected.model, allowed)) {
            const message = `Model not in scope: ${selected.model.provider}/${selected.model.id}`;
            if (invocation.modelFromParams) throw new Error(message);
            if (!warned.has(message)) { warned.add(message); ctx.ui.notify(message, "warning"); }
          }
        }
        let spawned: AgentRecord | undefined;
        const { record } = await manager.spawnAndWait(pi, ctx, type, request.prompt, {
          description: request.label,
          workflowId: deps.workflowId,
          selectedModel: { ...selected, modelInput: invocation.modelInput },
          model: selected.model,
          thinkingLevel: invocation.thinking,
          maxTurns: invocation.maxTurns,
          isolated: invocation.isolated,
          inheritContext: invocation.inheritContext,
          structuredOutput: request.schema,
          signal,
          invocation: {
            requestedModel: request.model ?? invocation.modelInput,
            requestedThinking: invocation.thinking,
            thinkingDefault: invocation.thinking === undefined,
          },
          onSessionCreated: session => {
            if (!spawned) return;
            resolvedInfo(spawned, request.onResolved);
            if (spawned.outputFile) spawned.outputCleanup = streamToOutputFile(session, spawned.outputFile, spawned.id, ctx.cwd);
          },
        }, id => {
          records.set(request.agentId, id);
          owned.add(id);
          spawned = manager.getRecord(id);
          request.onResolved?.({ recordId: id });
          if (spawned && (config?.outputTranscript ?? deps.outputTranscript?.() ?? true)) {
            spawned.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
            writeInitialEntry(spawned.outputFile, id, request.prompt, ctx.cwd);
          }
        });
        return toSpawnResult(record);
      } catch (error) {
        return { ok: false, skipped: signal.aborted, error: error instanceof Error ? error.message : String(error) };
      }
    },
    abortAgent(agentId) {
      controllers.get(agentId)?.abort();
      const id = records.get(agentId);
      if (id !== undefined) manager.abort(id);
    },
    async resumeAgent(agentId, prompt, report) {
      const id = records.get(agentId);
      const prior = id === undefined ? undefined : manager.getRecord(id);
      if (!prior?.session) return { ok: false, error: "No retained session to resume (30-minute retention within this parent session)." };
      const before = { tokens: getLifetimeTotal(prior.lifetimeUsage), output: prior.lifetimeUsage.output, tools: prior.toolUses };
      const record = await manager.resume(prior.id, prompt, attemptSignal(agentId), ctx);
      if (!record) return { ok: false, error: "Agent session is unavailable." };
      resolvedInfo(record, report);
      return toSpawnResult(record, before);
    },
    loadWorkflow: ref => resolveWorkflowSource(ref, ctx.cwd),
    async runGate(command, options) {
      if (disposed) throw new Error("Workflow host is disposed.");
      const signal = controllers.get(options.agentId)?.signal;
      const combined = deps.signal && signal ? AbortSignal.any([deps.signal, signal]) : deps.signal ?? signal;
      combined?.throwIfAborted();
      const shell = process.platform === "win32" ? "cmd" : "sh";
      const flag = process.platform === "win32" ? "/c" : "-c";
      const pending = pi.exec(shell, [flag, command], {
        cwd: options.cwd ?? ctx.cwd, signal: combined, timeout: deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
      });
      gates.add(pending);
      let result: ExecResult;
      try { result = await pending; } finally { gates.delete(pending); }
      return { ok: !combined?.aborted && !result.killed && result.code === 0,
        output: [result.stdout, result.stderr].filter(Boolean).join("\n") || (result.killed ? "Gate timed out or was cancelled." : ""),
      };
    },
  };
}
