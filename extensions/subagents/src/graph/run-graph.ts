/**
 * run-graph.ts — the async driver that executes an AgentGraph.
 *
 * Ties the pieces together: the pure {@link Scheduler} decides which nodes may
 * run, this launches each runnable agent node as an XState {@link nodeLogic}
 * actor (so cancellation and lifecycle are XState's), feeds every settle back into
 * the scheduler, and honours a global concurrency cap. The scheduler stays pure;
 * all the async lives here.
 *
 * `agent` nodes spawn a child agent; `graph` nodes recurse into a saved subgraph
 * (resolved through the injected {@link RunGraphOptions.loadGraph} so this file
 * stays filesystem-free); `expand` nodes splice a runtime {@link GraphFragment}
 * into the live scheduler. `human_gate` is layered on in a later phase; reaching
 * one now fails that node loudly rather than being silently skipped.
 */

import { createActor } from "xstate";
import type {
  AgentGraph,
  AgentNode,
  Condition,
  ExpandNode,
  GraphEdge,
  GraphFragment,
  GraphNode,
  HumanGateNode,
  NodeId,
  SubgraphNode,
  ValueRef,
} from "./ir.js";
import { compileJsonSchema } from "./json-schema.js";
import { checkNodeSchema, type NodeExecInput, nodeLogic } from "./node-actor.js";
import type { NodeHost, NodeResolvedInfo, NodeSpawnResult } from "./node-host.js";
import type { NodeRun, SchedulerState, SettleInput } from "./scheduler.js";
import { Scheduler } from "./scheduler.js";
import { validateFragment, validateGraph } from "./validate.js";
import { MISSING, type ResolutionContext, resolveValueRef } from "./value-ref.js";

export const DEFAULT_CONCURRENCY = 8;

/**
 * The run's control surface, handed to the caller once via
 * {@link RunGraphOptions.onControl}. Shape matches the script runtime's control
 * so the same `/agents` dialog keys drive both. Skip/retry address a node by its
 * declaration index (the order the monitor lists nodes in).
 */
export interface GraphControl {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  skip(index: number): boolean;
  retry(index: number): boolean;
}

export interface RunGraphOptions {
  host: NodeHost;
  concurrency?: number;
  signal?: AbortSignal;
  /**
   * Resolves a `graph` node's saved-graph reference to an inline {@link AgentGraph}.
   * Injected so this driver never touches the filesystem or the saved-graph store.
   */
  loadGraph?: (name: string) => AgentGraph | undefined;
  /**
   * Named resource capacities. A node's declared `resources` are each admitted
   * only while their in-use count is below the configured capacity; a resource
   * absent here is unlimited.
   */
  resources?: Record<string, { capacity: number }>;
  /**
   * Reports the initial post-hydration snapshot for each static node, then
   * running, settled, retried, and automatic-skip updates.
   */
  onNodeUpdate?(nodeId: string, run: Readonly<NodeRun>): void;
  /** Fired once the child agent's effective model is known. */
  onNodeResolved?(nodeId: string, info: NodeResolvedInfo): void;
  /** Hands the caller the run's control surface, once, before the first node. */
  onControl?(control: GraphControl): void;
  /** Restore progress from a prior run's snapshot (durable resume). */
  restore?: SchedulerState;
  /** Fired when a human_gate begins awaiting, carrying the run state to persist. */
  onGateWaiting?(nodeId: string, state: SchedulerState): void;
}

export interface RunGraphResult {
  status: "completed" | "failed" | "aborted";
  outputs: Record<string, unknown>;
  nodes: Record<string, { status: NodeRun["status"]; attempt: number; output?: unknown; error?: string }>;
}

/** One unit of in-flight async work — an agent actor or a recursing subgraph. */
interface Inflight {
  /** Resolves with the node id once the work has settled. */
  done: Promise<string>;
  /** The scheduler disposition, read after `done` resolves. */
  result(): SettleInput;
  /** Named resources held for the duration, released on settle. */
  resources: string[];
  /** Cancel the work (abort path). */
  stop(): void;
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
  if ((node.type === "agent" && node.outputSchema !== undefined) || node.type === "human_gate") {
    try {
      return JSON.parse(result.output);
    } catch {
      return result.output;
    }
  }
  return result.output;
}

function buildExecInput(
  nodeId: string,
  node: AgentNode,
  host: NodeHost,
  ctx: ResolutionContext,
  options: RunGraphOptions,
): NodeExecInput {
  const exec: NodeExecInput = {
    host,
    nodeId,
    agentType: node.agent,
    prompt: interpolate(node.prompt, node.input, ctx),
  };
  if (node.outputSchema !== undefined) {
    const compiled = compileJsonSchema(node.outputSchema);
    if (compiled.ok) exec.schema = compiled.compiled;
  }
  if (node.validation?.gate !== undefined) exec.gate = node.validation.gate;
  if (node.retry?.maxAttempts !== undefined) exec.maxAttempts = node.retry.maxAttempts;
  if (options.onNodeResolved !== undefined) {
    const cb = options.onNodeResolved;
    exec.onResolved = info => cb(nodeId, info);
  }
  return exec;
}

/** The resolution context over the scheduler's current completed outputs. */
function contextOf(scheduler: Scheduler, input: unknown): ResolutionContext {
  const outputs = new Map<string, unknown>();
  for (const [id, run] of scheduler.nodes) if (run.status === "completed") outputs.set(id, run.output);
  return { input, outputs };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a node's input ValueRefs into a plain object, omitting missing values. */
function resolveInputMap(input: Record<string, ValueRef> | undefined, ctx: ResolutionContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (input === undefined) return result;
  for (const [name, ref] of Object.entries(input)) {
    const value = resolveValueRef(ref, ctx);
    if (value !== MISSING) result[name] = value;
  }
  return result;
}

/** The options a subgraph node passes down to its child run (loader/resources/signal shared). */
function childOptions(options: RunGraphOptions): RunGraphOptions {
  const child: RunGraphOptions = { host: options.host };
  if (options.concurrency !== undefined) child.concurrency = options.concurrency;
  if (options.signal !== undefined) child.signal = options.signal;
  if (options.loadGraph !== undefined) child.loadGraph = options.loadGraph;
  if (options.resources !== undefined) child.resources = options.resources;
  return child;
}

/** Rewrite a ValueRef's `node` when it points at a fragment-internal id. */
function rewriteRef(ref: ValueRef, rename: (id: NodeId) => NodeId): ValueRef {
  return ref.node === undefined ? ref : { ...ref, node: rename(ref.node) };
}

/** Rewrite every ValueRef embedded in a condition tree. */
function rewriteCondition(cond: Condition, rename: (id: NodeId) => NodeId): Condition {
  if ("and" in cond) return { and: cond.and.map(sub => rewriteCondition(sub, rename)) };
  if ("or" in cond) return { or: cond.or.map(sub => rewriteCondition(sub, rename)) };
  if ("not" in cond) return { not: rewriteCondition(cond.not, rename) };
  if ("exists" in cond) return { exists: rewriteRef(cond.exists, rename) };
  if ("eq" in cond) return { eq: [rewriteRef(cond.eq[0], rename), cond.eq[1]] };
  if ("ne" in cond) return { ne: [rewriteRef(cond.ne[0], rename), cond.ne[1]] };
  if ("gt" in cond) return { gt: [rewriteRef(cond.gt[0], rename), cond.gt[1]] };
  if ("gte" in cond) return { gte: [rewriteRef(cond.gte[0], rename), cond.gte[1]] };
  if ("lt" in cond) return { lt: [rewriteRef(cond.lt[0], rename), cond.lt[1]] };
  return { lte: [rewriteRef(cond.lte[0], rename), cond.lte[1]] };
}

/** Rewrite a node's own ValueRefs (input map, or an expand node's source). */
function rewriteNode(node: GraphNode, rename: (id: NodeId) => NodeId): GraphNode {
  if (node.type === "expand") return { ...node, source: rewriteRef(node.source, rename) };
  if (node.input === undefined) return node;
  const input: Record<string, ValueRef> = {};
  for (const [name, ref] of Object.entries(node.input)) input[name] = rewriteRef(ref, rename);
  return { ...node, input };
}

/**
 * Relocate a fragment under `namespace`: every fragment-internal id becomes
 * `${namespace}:${id}`, and every reference to one — edge from/to, condition
 * ValueRefs, node input/source ValueRefs, and fragment outputs — is rewritten to
 * the new id. A reference to an id that is *not* internal to the fragment (already
 * in the run graph) is left untouched. With no namespace the fragment is returned
 * unchanged.
 */
export function namespaceFragment(fragment: GraphFragment, namespace: string | undefined): GraphFragment {
  if (namespace === undefined) return fragment;
  const internal = new Set(Object.keys(fragment.nodes));
  const rename = (id: NodeId): NodeId => (internal.has(id) ? `${namespace}:${id}` : id);

  const nodes: Record<NodeId, GraphNode> = {};
  for (const [id, node] of Object.entries(fragment.nodes)) nodes[rename(id)] = rewriteNode(node, rename);

  const edges = fragment.edges.map(edge => {
    const next: GraphEdge = { ...edge, from: rename(edge.from), to: rename(edge.to) };
    if (edge.when !== undefined) next.when = rewriteCondition(edge.when, rename);
    return next;
  });

  const result: GraphFragment = { nodes, edges };
  if (fragment.outputs !== undefined) {
    const outputs: Record<string, ValueRef> = {};
    for (const [name, ref] of Object.entries(fragment.outputs)) outputs[name] = rewriteRef(ref, rename);
    result.outputs = outputs;
  }
  return result;
}

/**
 * A model calling `agent_graph` often passes a structured `input` as a JSON
 * string rather than an object, so `$.field` ValueRefs would resolve to MISSING
 * and every `${placeholder}` would reach the agent literally. Parse a JSON
 * string back to its value at the one entry point every run shares.
 */
export function coerceGraphInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export async function runGraph(graph: AgentGraph, input: unknown, options: RunGraphOptions): Promise<RunGraphResult> {
  input = coerceGraphInput(input);
  const scheduler = new Scheduler(graph, input);
  if (options.restore !== undefined) scheduler.hydrate(options.restore);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const inflight = new Map<string, Inflight>();
  // Node definitions grow at runtime when an expand node splices a fragment in.
  const nodeDefs = new Map<NodeId, GraphNode>(Object.entries(graph.nodes));
  // Live count of each named resource in use by inflight nodes.
  const inUse = new Map<string, number>();

  const capacityOf = (name: string): number | undefined => options.resources?.[name]?.capacity;
  const canAdmit = (resources: string[]): boolean => {
    for (const name of resources) {
      const cap = capacityOf(name);
      if (cap !== undefined && (inUse.get(name) ?? 0) >= cap) return false;
    }
    return true;
  };
  const acquire = (resources: string[]): void => {
    for (const name of resources) inUse.set(name, (inUse.get(name) ?? 0) + 1);
  };
  const release = (resources: string[]): void => {
    for (const name of resources) {
      const next = (inUse.get(name) ?? 0) - 1;
      if (next <= 0) inUse.delete(name);
      else inUse.set(name, next);
    }
  };

  const stopAll = (): void => {
    for (const entry of inflight.values()) entry.stop();
    inflight.clear();
  };

  const report = (id: string): void => {
    const run = scheduler.nodes.get(id);
    if (run !== undefined) options.onNodeUpdate?.(id, run);
  };

  const launchAgent = (id: string, node: AgentNode, resources: string[]): void => {
    scheduler.markRunning(id);
    report(id);
    acquire(resources);
    const exec = buildExecInput(id, node, options.host, contextOf(scheduler, input), options);
    const actor = createActor(nodeLogic, { input: exec });
    let failure: string | undefined;
    const done = new Promise<string>(resolve => {
      // Resolve on any terminal transition — done, or stopped by a skip/retry —
      // so a cancelled node's inflight entry never hangs the run loop.
      actor.subscribe({
        next: snapshot => {
          if (snapshot.status === "done" || snapshot.status === "stopped") resolve(id);
        },
        error: err => {
          failure = err instanceof Error ? err.message : String(err);
          resolve(id);
        },
        complete: () => resolve(id),
      });
      actor.start();
    });
    inflight.set(id, {
      done,
      resources,
      stop: () => actor.stop(),
      result: () => {
        if (failure !== undefined) return { ok: false, error: failure };
        const out = (actor.getSnapshot().output ?? { ok: false, error: "node produced no result" }) as NodeSpawnResult;
        return { ok: out.ok, output: parseOutput(node, out), error: out.error, skipped: out.skipped };
      },
    });
  };

  const launchSubgraph = (id: string, node: SubgraphNode): void => {
    scheduler.markRunning(id);
    report(id);
    // Resolve the child input now, against the context at launch time.
    const childInput = resolveInputMap(node.input, contextOf(scheduler, input));
    let settle: SettleInput = { ok: false, error: `subgraph node "${id}" did not run` };
    const done = (async (): Promise<string> => {
      const loader = options.loadGraph;
      if (loader === undefined) {
        settle = { ok: false, error: `subgraph node "${id}" needs a loadGraph loader, but none was provided` };
        return id;
      }
      const childGraph = loader(node.graph);
      if (childGraph === undefined) {
        settle = { ok: false, error: `subgraph "${node.graph}" could not be resolved` };
        return id;
      }
      const validation = validateGraph(childGraph);
      if (!validation.ok) {
        settle = { ok: false, error: `subgraph "${node.graph}" is invalid: ${validation.errors.join("; ")}` };
        return id;
      }
      const childResult = await runGraph(childGraph, childInput, childOptions(options));
      settle =
        childResult.status === "completed"
          ? { ok: true, output: childResult.outputs }
          : { ok: false, error: `subgraph "${node.graph}" ${childResult.status}` };
      return id;
    })();
    inflight.set(id, { done, resources: [], stop: () => {}, result: () => settle });
  };

  /** Await a human decision for a human_gate node. Abortable via its own controller. */
  const launchHumanGate = (id: string, node: HumanGateNode): void => {
    scheduler.markRunning(id);
    report(id);
    const awaitGate = options.host.awaitHumanGate?.bind(options.host);
    const prompt = interpolate(node.prompt, node.input, contextOf(scheduler, input));
    const compiled = compileJsonSchema(node.outputSchema);
    const schema = compiled.ok ? compiled.compiled : undefined;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let settle: SettleInput = { ok: false, error: `human_gate node "${id}" did not resolve` };
    const done = (async (): Promise<string> => {
      if (awaitGate === undefined) {
        settle = { ok: false, error: `human_gate node "${id}" needs a host that can await human input` };
        return id;
      }
      const request = schema !== undefined ? { nodeId: id, prompt, schema } : { nodeId: id, prompt };
      // Persist the waiting state so a restart can resume this gate.
      options.onGateWaiting?.(id, scheduler.snapshotState());
      try {
        let result = await awaitGate(request, signal);
        if (result.ok && schema !== undefined) result = checkNodeSchema(result, schema);
        settle = { ok: result.ok, output: parseOutput(node, result), error: result.error, skipped: result.skipped };
      } catch (err) {
        settle = signal.aborted
          ? { ok: false, skipped: true, error: "Aborted." }
          : { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      return id;
    })();
    inflight.set(id, { done, resources: [], stop: () => controller.abort(), result: () => settle });
  };

  /** Splice a fragment resolved from an expand node's source into the live run. Synchronous. */
  const expandNode = (id: string, node: ExpandNode): void => {
    scheduler.markRunning(id);
    report(id);
    const source = resolveValueRef(node.source, contextOf(scheduler, input));
    if (source === MISSING || !isPlainObject(source)) {
      scheduler.settle(id, { ok: false, error: `expand node "${id}" source did not resolve to a GraphFragment` });
      report(id);
      return;
    }
    const fragment = source as unknown as GraphFragment;
    const validation = validateFragment(fragment, scheduler.nodeIds());
    if (!validation.ok) {
      scheduler.settle(id, { ok: false, error: `expand node "${id}" fragment is invalid: ${validation.errors.join("; ")}` });
      report(id);
      return;
    }
    // Namespacing relocates the (already valid) fragment so its ids and internal
    // references are isolated from the run graph.
    const placed = namespaceFragment(fragment, node.namespace);
    for (const [fid, fnode] of Object.entries(placed.nodes)) nodeDefs.set(fid, fnode);
    scheduler.insertFragment(placed);
    scheduler.settle(id, { ok: true, output: {} });
    report(id);
  };

  const orderedIds = Object.keys(graph.nodes);
  const intents = new Map<string, "skip" | "retry">();
  let paused = false;
  let wakePause: (() => void) | undefined;
  options.onControl?.({
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      wakePause?.();
      wakePause = undefined;
    },
    isPaused: () => paused,
    skip: index => {
      const id = orderedIds[index];
      if (id === undefined) return false;
      const entry = inflight.get(id);
      if (entry !== undefined) {
        intents.set(id, "skip");
        entry.stop();
        return true;
      }
      if (scheduler.nodes.get(id)?.status === "pending") {
        scheduler.settle(id, { ok: false, skipped: true });
        report(id);
        return true;
      }
      return false;
    },
    retry: index => {
      const id = orderedIds[index];
      if (id === undefined) return false;
      const entry = inflight.get(id);
      if (entry === undefined) return false;
      intents.set(id, "retry");
      entry.stop();
      return true;
    },
  });
  // Seed the monitor from authoritative hydrated state before scheduling. Dynamic
  // expand nodes remain reported only through their runtime transitions.
  for (const id of orderedIds) report(id);

  // Resolves the moment the run is aborted, so the loop unblocks even when an
  // inflight node (e.g. a human_gate whose resolver ignores the signal) never
  // settles — otherwise shutdown would hang on a parked gate.
  const ABORTED = Symbol("aborted");
  const abortRace = new Promise<typeof ABORTED>(resolve => {
    if (options.signal?.aborted) resolve(ABORTED);
    else options.signal?.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });

  while (true) {
    if (options.signal?.aborted) {
      stopAll();
      return { status: "aborted", outputs: {}, nodes: snapshotNodes(scheduler) };
    }

    // Did this pass settle or splice anything synchronously? If so we must
    // re-evaluate readiness before treating the run as quiescent — an expand
    // node inserts fresh roots that would otherwise be force-skipped as stuck.
    let progressed = false;
    for (const id of scheduler.ready()) {
      if (paused) break; // pause stops new admission; inflight nodes still finish
      if (inflight.size >= concurrency) break;
      if (inflight.has(id)) continue;
      const node = nodeDefs.get(id);
      if (node === undefined) {
        scheduler.settle(id, { ok: false, error: `no definition found for node "${id}"` });
        report(id);
        progressed = true;
        continue;
      }
      const resources = node.type === "agent" && node.resources !== undefined ? node.resources : [];
      // Blocked purely by resource capacity: leave pending, retry on a later pass.
      if (!canAdmit(resources)) continue;
      if (node.type === "agent") {
        launchAgent(id, node, resources);
        continue;
      }
      if (node.type === "graph") {
        launchSubgraph(id, node);
        continue;
      }
      if (node.type === "expand") {
        expandNode(id, node);
        progressed = true;
        continue;
      }
      if (node.type === "human_gate") {
        if (options.host.awaitHumanGate === undefined) {
          scheduler.settle(id, { ok: false, error: `human_gate node "${id}" needs a host that can await human input` });
          report(id);
          progressed = true;
          continue;
        }
        launchHumanGate(id, node);
        continue;
      }
      scheduler.settle(id, { ok: false, error: `node type "${(node as { type: string }).type}" is not supported yet` });
      report(id);
      progressed = true;
    }

    if (progressed) continue;

    if (inflight.size === 0) {
      if (paused && !options.signal?.aborted) {
        // Held with nothing running: wait for resume (or abort) rather than
        // finishing the run.
        await new Promise<void>(resolve => {
          wakePause = resolve;
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        continue;
      }
      const resolvedSkips = scheduler.resolveSkips();
      for (const id of resolvedSkips) report(id);
      if (resolvedSkips.length > 0) continue;
      if (scheduler.isDone()) break;
      const stuckSkips = scheduler.forceSkipStuck();
      for (const id of stuckSkips) report(id);
      continue;
    }

    const settled = await Promise.race<string | typeof ABORTED>([abortRace, ...[...inflight.values()].map(entry => entry.done)]);
    if (settled === ABORTED) {
      stopAll();
      return { status: "aborted", outputs: {}, nodes: snapshotNodes(scheduler) };
    }
    const settledId = settled;
    const entry = inflight.get(settledId);
    inflight.delete(settledId);
    if (entry !== undefined) release(entry.resources);
    const intent = intents.get(settledId);
    intents.delete(settledId);
    if (intent === "retry") {
      scheduler.retry(settledId);
      report(settledId);
      continue;
    }
    const settle: SettleInput =
      intent === "skip" ? { ok: false, skipped: true } : (entry?.result() ?? { ok: false, error: "node produced no result" });
    scheduler.settle(settledId, settle);
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
