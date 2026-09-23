import { readWorkflowNodeDetail } from "./history-artifact.js";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { firstMeaningfulLine, renderToolCall, renderToolExpanded, renderToolSummary } from "../../../lib/tool-output.js";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import type { NotificationDetails } from "../types.js";
import type { FleetWorkflow } from "../ui/fleet-list.js";
import { renderWorkflowCard } from "../ui/workflow-report.js";
import { getLifetimeTotal } from "../usage.js";
import { checkGraphDelegation } from "./delegation-preflight.js";
import { workflowEntryData } from "./entry.js";
import { type CheckpointLease, LiveWriterError } from "./graph-checkpoint-owner.js";
import { deleteGraphSnapshot, graphRunHasLiveWriter, ownGraphRun, readGraphSnapshots, writeGraphSnapshot } from "./graph-persist.js";
import { authorizeGraphResume } from "./graph-resume-preflight.js";
import { completeGraphTask, GraphRunReporter } from "./graph-run-adapter.js";
import { GraphHistoryStore } from "./history.js";
import { mergeWorkflowRuns } from "./history-view.js";
import type { AgentGraph } from "./ir.js";
import { createNodeHost, type NodeHostOptions } from "./node-host-adapter.js";
import { workflowCompletionText } from "./notification.js";
import { elapsedMs } from "./progress.js";
import { coerceGraphInput, type RunGraphResult, runGraph } from "./run-graph.js";
import { resolveSavedGraph } from "./saved-graph.js";
import type { SchedulerState } from "./scheduler.js";
import { createWorkflowTask, failWorkflowTask, type WorkflowTask, workflowResultText, workflowRunId } from "./task.js";
import { graphToolDescription } from "./tool-description.js";
import { validateGraph } from "./validate.js";

/** Activation-owned execution policy, read live when a graph starts a child. */
export interface WorkflowExecutionHost extends Readonly<Pick<NodeHostOptions, "pi" | "manager" | "scopeModels" | "outputTranscript">> {
  readonly enabled: () => boolean;
  readonly delegationDenial: (ctx: ExtensionContext, type: string) => string | undefined;
}

/** Held delivery is shared with ordinary background-agent completions. */
export interface WorkflowNotifications {
  readonly schedule: (key: string, send: () => void) => void;
  readonly cancel: (key: string) => void;
}

interface GraphLaunch {
  readonly graph: AgentGraph;
  readonly input: unknown;
  readonly restore?: SchedulerState;
}

// allow: SIZE_OK — the typed graph tool and its session state share one lifecycle closure.
export function createWorkflowRuntime(
  execution: WorkflowExecutionHost,
  notifications: WorkflowNotifications,
  refresh: (surface: "pane" | "fleet" | "all") => void,
) {
  const { pi, manager } = execution;
  let history: GraphHistoryStore | undefined;
  const tasks = new Map<string, WorkflowTask>();
  let artifactScope: { cwd: string; sessionId: string } | undefined;
  const getRuns = () => {
    const scope = artifactScope;
    return mergeWorkflowRuns(tasks.values(), history?.runs ?? [], scope ? (runId, index) => readWorkflowNodeDetail(scope, runId, index) : undefined);
  };
  const runs = new Set<Promise<void>>();
  let sessionActive = true;

  async function loadHistory(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    history = await GraphHistoryStore.load(sessionId, message => ctx.ui.notify(message, "warning"));
    artifactScope = { cwd: ctx.cwd, sessionId };
    sessionActive = true;
  }

  /** Settle the task and map node updates onto its progress log. */
  async function runTask(ctx: ExtensionContext, task: WorkflowTask, launch: GraphLaunch): Promise<void> {
    const { graph, input, restore } = launch;
    const ownerSessionId = ctx.sessionManager.getSessionId();
    const reporter = new GraphRunReporter(task, graph, Date.now(), recordId => {
      const r = manager.getRecord(recordId);
      return r ? { toolCalls: r.toolUses, tokens: getLifetimeTotal(r.lifetimeUsage) } : undefined;
    });
    const host = createNodeHost({
      pi,
      ctx,
      manager,
      signal: task.abortController.signal,
      scopeModels: execution.scopeModels,
      outputTranscript: execution.outputTranscript,
      workflowId: task.id,
      nodeIndex: nodeId => reporter.nodeIndex(nodeId),
    });
    // Node entries otherwise re-emit only on status transitions; refresh live counters too.
    const activityTick = setInterval(() => {
      reporter.refresh();
      refresh("pane");
    }, 1000);
    activityTick.unref?.();
    let releaseCheckpoint: CheckpointLease | undefined;
    let result: RunGraphResult | undefined;
    let failure: { error: unknown } | undefined;
    try {
      releaseCheckpoint = ownGraphRun(ctx.cwd, task.id);
      result = await runGraph(graph, input, {
        host,
        runId: task.id,
        reclaimedDeadWriter: releaseCheckpoint.reclaimedDeadWriter,
        authorizeAgent: agent => execution.delegationDenial(ctx, agent),
        onCheckpoint: (state, effectiveGraph) => {
          writeGraphSnapshot(ctx.cwd, {
            version: 2, runId: task.id, ownerSessionId, graph: effectiveGraph, input, waitingGate: "",
            ...(task.meta?.name !== undefined ? { name: task.meta.name } : {}),
            state, savedAt: Date.now(),
          });
        },
        signal: task.abortController.signal,
        ...(restore !== undefined ? { restore } : {}),
        loadGraph: name => {
          const resolved = resolveSavedGraph(name, ctx.cwd);
          return resolved.ok ? (resolved.graph as AgentGraph) : undefined;
        },
        onControl: control => {
          task.control = control;
        },
        onNodeAdded: (nodeId, node, metadata) => {
          reporter.registerNode(nodeId, node, metadata);
          refresh("pane");
        },
        onNodeUpdate: (nodeId, run, correlation, presentation) => {
          reporter.update(nodeId, run, correlation, undefined, presentation);
          refresh("pane");
        },
        onNodeResolved: (nodeId, info, correlation) => {
          reporter.setResolved(nodeId, info, correlation);
          refresh("pane");
        },
      });
    } catch (error) {
      failure = { error: error instanceof Error ? error : new Error(String(error)) };
    }
    clearInterval(activityTick);
    try {
      await host.dispose();
    } catch (error) {
      failure ??= { error: error instanceof Error ? error : new Error(String(error)) };
    }
    try {
      if (failure) throw failure.error;
      if (result) {
        completeGraphTask(task, result);
        // Lifecycle aborts retain the checkpoint; genuinely settled runs clear it.
        if (result.status !== "aborted" || !["reload", "switch", "shutdown"].includes(task.abortController.signal.reason)) deleteGraphSnapshot(ctx.cwd, task.id);
      }
    } catch (err) {
      // A live owner refused the lease during the resume race: decline rather than
      // fabricate a failure. Snapshot + live owner are left untouched.
      if (err instanceof LiveWriterError) tasks.delete(task.id);
      else failWorkflowTask(task, err instanceof Error ? err.message : String(err));
    } finally { releaseCheckpoint?.(); }
    refresh("pane");
  }

  /** Detached runs remain owned until shutdown has awaited them. */
  function launchGraph(ctx: ExtensionContext, task: WorkflowTask, launch: GraphLaunch): void {
    const normalizedInput = coerceGraphInput(launch.input);
    task.args = normalizedInput;
    const run = runTask(ctx, task, { ...launch, input: normalizedInput })
      .then(() => {
        if (sessionActive && tasks.get(task.id) === task) {
          history?.capture(task);
          notifyFinished(ctx, task);
        }
      })
      .catch(error => console.warn(`[pi-subagents] graph completion: ${String(error)}`));
    runs.add(run);
    void run.finally(() => runs.delete(run));
  }

  /** Resume the last complete checkpoint, including gates and feedback transitions. */
  function resume(ctx: ExtensionContext): void {
    for (const snap of readGraphSnapshots(ctx.cwd, message => ctx.ui.notify(message, "error"))) {
      if (!snap.ownerSessionId || snap.ownerSessionId !== ctx.sessionManager.getSessionId() || tasks.has(snap.runId)) continue;
      if (graphRunHasLiveWriter(ctx.cwd, snap.runId)) continue; // another live process still owns this run
      try {
        authorizeGraphResume(snap, {
          deny: type => execution.delegationDenial(ctx, type),
          load: name => { const resolved = resolveSavedGraph(name, ctx.cwd); return resolved.ok ? resolved.graph as AgentGraph : undefined; },
        });
      } catch (error) {
        ctx.ui.notify(`Cannot resume graph ${snap.runId}: ${error instanceof Error ? error.message : String(error)}`, "error");
        continue;
      }
      const name = snap.name ?? snap.runId;
      const task = createWorkflowTask({
        id: snap.runId,
        script: "",
        args: snap.input,
        meta: {
          name,
          description: snap.graph.description ?? `agent graph ${name}`,
          inputSchema: snap.graph.inputSchema,
        },
      });
      tasks.set(snap.runId, task);
      launchGraph(ctx, task, { graph: snap.graph, input: snap.input, restore: snap.state });
    }
    refresh("all");
  }

  async function stop(cause: "reload" | "switch" | "shutdown"): Promise<void> {
    history?.disableCapture(cause);
    sessionActive = false;
    for (const task of tasks.values()) {
      notifications.cancel(task.id);
      task.abortController.abort(cause);
    }
    await Promise.allSettled(runs);
    await history?.flush();
    history = undefined;
    tasks.clear();
  }

  /** Only cached counters: fleet reads this on its 200ms rendering tick. */
  function fleetWorkflows(): FleetWorkflow[] {
    return [...tasks.values()].map(task => ({
      id: task.id,
      name: task.meta?.name ?? task.workflowName ?? task.id,
      status: task.status,
      doneCount: task.doneCount,
      totalCount: task.agentCount,
      startedAt: task.startTime,
      ...(task.endTime !== undefined ? { completedAt: task.endTime } : {}),
      tokens: task.totalTokens,
    }));
  }

  function notifyFinished(ctx: ExtensionContext, task: WorkflowTask) {
    if (!sessionActive || tasks.get(task.id) !== task) return;
    refresh("fleet");
    const result = workflowResultText(task);
    notifications.schedule(task.id, () => {
      if (!sessionActive || tasks.get(task.id) !== task) return;
      pi.sendMessage<NotificationDetails>({
        customType: "subagent-notification",
        content: workflowCompletionText(ctx, task),
        display: true,
        details: {
          id: task.id,
          description: `Workflow ${task.workflowName ?? task.id}`,
          status: task.status === "completed" ? "completed" : task.status === "killed" ? "stopped" : "error",
          toolUses: task.totalToolCalls,
          // A workflow has agents, not turns; rendering "↻0" would be noise.
          turnCount: 0,
          totalTokens: task.totalTokens,
          durationMs: elapsedMs(task, Date.now()),
          error: task.error,
          resultPreview: result.length > 500 ? `${result.slice(0, 500)}…` : result,
          workflow: workflowEntryData(task),
        },
      }, { deliverAs: "followUp", triggerTurn: true });
    });
  }

  const tool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT_GRAPH,
    label: "agent_graph",
    description: graphToolDescription,
    promptSnippet: "Run a typed agent graph",
    parameters: Type.Object({
      graph: Type.Union(
        [
          Type.String({ description: "Saved graph name, e.g. `context-gather`." }),
          Type.Object({}, { additionalProperties: true, description: "Inline AgentGraph { nodes, edges, outputs? }." }),
        ],
        { description: "A saved-graph name or an inline AgentGraph." },
      ),
      input: Type.Optional(Type.Any({ description: "Graph input, readable via ValueRefs that omit `node`." })),
    }),
    renderCall(args, theme) {
      const graph: unknown = args.graph;
      const name = typeof graph === "string" ? graph : ((graph as { name?: string } | null)?.name ?? "inline graph");
      return renderToolCall("agent_graph", String(name), theme);
    },
    renderResult(result, options, theme, renderContext) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const taskId = (result.details as { taskId?: string } | undefined)?.taskId;
      const task = taskId !== undefined ? tasks.get(taskId) : undefined;
      if (renderContext.isError || !task) {
        const status = renderContext.isError
          ? "Failed"
          : "Live graph state unavailable in this session — see /agents › Workflows or the completion notification";
        const expandLabel = renderContext.isError ? "diagnostics" : "details";
        return options.expanded
          ? renderToolExpanded(`${status}\n${text || "No output."}`)
          : renderToolSummary([status, firstMeaningfulLine(text) || "No output"], theme, { expandable: true, expandLabel });
      }
      return renderWorkflowCard(
        { progress: task.workflowProgress, task, expanded: options.expanded, meta: task.meta, agentCount: task.agentCount, totalTokens: task.totalTokens },
        theme,
      );
    },
    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!execution.enabled() || !sessionActive) return {
        content: [{ type: "text" as const, text: "Agent graphs are unavailable in this session." }], details: undefined,
      };
      let graph: unknown;
      let graphName: string;
      if (typeof params.graph === "string") {
        const resolved = resolveSavedGraph(params.graph, ctx.cwd);
        if (!resolved.ok) throw new Error(resolved.message);
        graph = resolved.graph;
        graphName = params.graph;
      } else {
        graph = params.graph;
        graphName = (graph as { name?: string } | null)?.name ?? "inline graph";
      }
      const verdict = validateGraph(graph);
      if (!verdict.ok) throw new Error(`Invalid agent graph:\n- ${verdict.errors.join("\n- ")}`);

      const runId = workflowRunId();
      const input = coerceGraphInput(params.input);
      const liveGraph = graph as AgentGraph;
      // Reject disallowed graphs before creating a task or spawning any child.
      const preflight = checkGraphDelegation(
        liveGraph,
        type => execution.delegationDenial(ctx, type),
        name => {
          const resolved = resolveSavedGraph(name, ctx.cwd);
          return resolved.ok ? (resolved.graph as AgentGraph) : undefined;
        },
      );
      if (!preflight.ok) throw new Error(preflight.error);
      const task = createWorkflowTask({
        id: runId,
        script: "",
        args: input,
        meta: {
          name: graphName,
          description: liveGraph.description ?? `agent graph ${graphName}`,
          inputSchema: liveGraph.inputSchema,
        },
        toolCallId,
      });
      tasks.set(runId, task);
      refresh("all");
      launchGraph(ctx, task, { graph: liveGraph, input });

      return {
        content: [{
          type: "text" as const,
          text:
            `Agent graph "${graphName}" started in the background.\n` +
            `Task ID: ${runId}\n` +
            `\nYou will be notified when it finishes — do NOT poll or sleep waiting for it.`,
        }],
        details: { taskId: runId },
      };
    },
  });

  return { tool, loadHistory, getRuns, resume, stop, fleetWorkflows };
}
