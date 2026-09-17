/**
 * run-graph.ts — the async driver that executes an AgentGraph.
 *
 * Ties the pieces together: the pure {@link Scheduler} decides which nodes may
 * run, this launches each runnable agent node as an XState {@link agentNodeLogic}
 * actor (so cancellation and lifecycle are XState's), feeds every settle back into
 * the scheduler, and honours a global concurrency cap. The scheduler stays pure;
 * all the async lives here.
 *
 * Only `agent` nodes execute here. `human_gate`, `graph`, and `expand` are layered
 * on in later phases; reaching one now fails that node loudly rather than being
 * silently skipped, so an unfinished capability never masquerades as success.
 */

import { createActor } from "xstate";
import type { AgentGraph, AgentNode, GraphNode } from "./ir.js";
import { compileJsonSchema } from "./json-schema.js";
import { agentNodeLogic } from "./node-actor.js";
import type { NodeHost, NodeSpawnRequest, NodeSpawnResult } from "./node-host.js";
import type { NodeRun } from "./scheduler.js";
import { Scheduler } from "./scheduler.js";
import { MISSING, type ResolutionContext, resolveValueRef } from "./value-ref.js";

export const DEFAULT_CONCURRENCY = 8;

export interface RunGraphOptions {
  host: NodeHost;
  concurrency?: number;
  signal?: AbortSignal;
  /** Fired whenever a node changes state — the monitor's data feed. */
  onNodeUpdate?(nodeId: string, run: Readonly<NodeRun>): void;
}

export interface RunGraphResult {
  status: "completed" | "failed" | "aborted";
  outputs: Record<string, unknown>;
  nodes: Record<string, { status: NodeRun["status"]; attempt: number; output?: unknown; error?: string }>;
}

/** Substitute `${name}` in a prompt with the resolved value of that input. */
function interpolate(prompt: string, input: AgentNode["input"], ctx: ResolutionContext): string {
  if (input === undefined) return prompt;
  return prompt.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, name: string) => {
    const ref = input[name];
    if (ref === undefined) return whole;
    const value = resolveValueRef(ref, ctx);
    if (value === MISSING) return whole;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/** Parse a completed node's output for the scheduler: JSON when schema'd, else text. */
function parseOutput(node: GraphNode, result: NodeSpawnResult): unknown {
  if (!result.ok || result.output === undefined) return undefined;
  if (node.type === "agent" && node.outputSchema !== undefined) {
    try {
      return JSON.parse(result.output);
    } catch {
      return result.output;
    }
  }
  return result.output;
}

function buildRequest(nodeId: string, node: AgentNode, attempt: number, ctx: ResolutionContext): NodeSpawnRequest {
  const request: NodeSpawnRequest = {
    nodeId,
    attempt,
    agentType: node.agent,
    prompt: interpolate(node.prompt, node.input, ctx),
  };
  if (node.outputSchema !== undefined) {
    const compiled = compileJsonSchema(node.outputSchema);
    if (compiled.ok) request.schema = compiled.compiled;
  }
  return request;
}

/** The resolution context over the scheduler's current completed outputs. */
function contextOf(scheduler: Scheduler, input: unknown): ResolutionContext {
  const outputs = new Map<string, unknown>();
  for (const [id, run] of scheduler.nodes) if (run.status === "completed") outputs.set(id, run.output);
  return { input, outputs };
}

export async function runGraph(graph: AgentGraph, input: unknown, options: RunGraphOptions): Promise<RunGraphResult> {
  const scheduler = new Scheduler(graph, input);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const inflight = new Map<string, { actor: ReturnType<typeof createActor>; done: Promise<string> }>();

  const stopAll = (): void => {
    for (const { actor } of inflight.values()) actor.stop();
    inflight.clear();
  };

  const report = (id: string): void => {
    const run = scheduler.nodes.get(id);
    if (run !== undefined) options.onNodeUpdate?.(id, run);
  };

  const launch = (id: string, node: AgentNode): void => {
    scheduler.markRunning(id);
    report(id);
    const request = buildRequest(id, node, scheduler.nodes.get(id)?.attempt ?? 1, contextOf(scheduler, input));
    const actor = createActor(agentNodeLogic, { input: { host: options.host, request } });
    const done = new Promise<string>(resolve => {
      actor.subscribe(snapshot => {
        if (snapshot.status === "done") resolve(id);
      });
      actor.start();
    });
    inflight.set(id, { actor, done });
  };

  while (true) {
    if (options.signal?.aborted) {
      stopAll();
      return { status: "aborted", outputs: {}, nodes: snapshotNodes(scheduler) };
    }

    for (const id of scheduler.ready()) {
      if (inflight.size >= concurrency) break;
      if (inflight.has(id)) continue;
      const node = graph.nodes[id];
      if (node.type !== "agent") {
        scheduler.settle(id, { ok: false, error: `node type "${node.type}" is not supported yet` });
        report(id);
        continue;
      }
      launch(id, node);
    }

    if (inflight.size === 0) {
      if (scheduler.resolveSkips() > 0) continue;
      if (scheduler.isDone()) break;
      scheduler.forceSkipStuck();
      continue;
    }

    const settledId = await Promise.race([...inflight.values()].map(entry => entry.done));
    const entry = inflight.get(settledId);
    inflight.delete(settledId);
    const result = (entry?.actor.getSnapshot().output ?? { ok: false, error: "node produced no result" }) as NodeSpawnResult;
    const node = graph.nodes[settledId];
    scheduler.settle(settledId, {
      ok: result.ok,
      output: parseOutput(node, result),
      error: result.error,
      skipped: result.skipped,
    });
    report(settledId);
  }

  return {
    status: scheduler.runStatus() === "failed" ? "failed" : "completed",
    outputs: scheduler.resolveOutputs(),
    nodes: snapshotNodes(scheduler),
  };
}

function snapshotNodes(scheduler: Scheduler): RunGraphResult["nodes"] {
  const nodes: RunGraphResult["nodes"] = {};
  for (const [id, run] of scheduler.nodes) {
    nodes[id] = { status: run.status, attempt: run.attempt, output: run.output, error: run.error };
  }
  return nodes;
}
