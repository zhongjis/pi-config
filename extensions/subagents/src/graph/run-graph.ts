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

import { randomUUID } from "node:crypto";
import { createActor } from "xstate";
import { BoundedFeedback, decision, type FeedbackResult } from "./bounded-feedback.js";
import { prepareFanout } from "./fanout.js";
import { GraphInstances, type NodeInstance } from "./graph-instance-id.js";
import { nestedMaterializations, nestedScope, restoredNestedRows } from "./graph-nested-checkpoint.js";
import { validateGraphRestore } from "./graph-restore-validation.js";
import { validateSchedulerState } from "./graph-state-validation.js";
import type {
  AgentGraph,
  AgentNode,
  Condition,
  ExpandNode,
  FanoutNode,
  FanoutPhase,
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
import { MAX_NODES, validateFragment, validateGraph } from "./validate.js";
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
  runId?: string;
  allocateInstanceId?: () => string;
  /** Injectable epoch-millisecond clock for durable feedback deadlines. */
  now?: () => number;
  /** Synchronous durable commit; throwing prevents further dispatch. Required for v2. */
  onCheckpoint?(state: SchedulerState, graph: AgentGraph): void;
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
  /** Register dynamic rows before their first update; dependencies are display-only. */
  onNodeAdded?(nodeId: string, node: GraphNode, metadata: { dependencies: string[]; phase?: FanoutPhase; instance?: NodeInstance; ordinal?: number; materializationKey?: string }): void;
  /** Fired once the child agent's effective model is known. */
  onNodeResolved?(nodeId: string, info: NodeResolvedInfo): void;
  /** Hands the caller the run's control surface, once, before the first node. */
  onControl?(control: GraphControl): void;
  /** Restore progress from a prior run's snapshot (durable resume). */
  restore?: SchedulerState;
  /** Fired when a human_gate begins awaiting, carrying the run state to persist. */
  onGateWaiting?(nodeId: string, state: SchedulerState, effectiveGraph: AgentGraph): void;
}

export interface RunGraphResult {
  readonly feedback?: Readonly<Record<string, FeedbackResult>>;
  status: "completed" | "failed" | "aborted";
  outputs: Record<string, unknown>;
  nodes: Record<string, NodeRun>;
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
  const child: RunGraphOptions = { host: options.host, now: options.now };
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
  if (node.type === "bounded_feedback") return node; // Forbidden in runtime fragments.
  if (node.type === "expand") return { ...node, source: rewriteRef(node.source, rename) };
  if (node.type === "fanout") node = { ...node, items: rewriteRef(node.items, rename) };
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

// allow: SIZE_OK — admission, controls, and settlement share the same live scheduler/actor closure.
export async function runGraph(graph: AgentGraph, input: unknown, options: RunGraphOptions): Promise<RunGraphResult> {
  if (graph.version !== undefined && graph.version !== 1 && graph.version !== 2) throw new TypeError("Unsupported graph version");
  if (graph.version !== 2 && Object.values(graph.nodes).some(node => node.type === "bounded_feedback")) throw new TypeError("Bounded feedback requires version 2");
  if ((graph.version === 2 || options.restore?.runtime !== undefined) && !options.onCheckpoint) throw new TypeError("Version 2 requires a durable checkpoint writer");
  if (graph.version === 2) {
    const validation = validateGraph(graph);
    if (!validation.ok) throw new TypeError(validation.errors.join("; "));
  }
  if (graph.version === 2 && options.restore && !options.restore.runtime) throw new TypeError("Missing v2 restore manifest");
  input = coerceGraphInput(input);
  if (options.restore) {
    validateSchedulerState(options.restore, graph);
    if (options.restore.runtime) validateGraphRestore(options.restore, graph, input);
  }
  const scheduler = new Scheduler(graph, input);
  if (options.restore !== undefined) scheduler.hydrate(options.restore);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const inflight = new Map<string, Inflight>();
  // Node definitions grow at runtime when an expand node splices a fragment in.
  const nodeDefs = new Map<NodeId, GraphNode>(Object.entries(graph.nodes));
  const effectiveEdges = [...graph.edges];
  const effectiveGraph = (): AgentGraph => ({ ...graph, nodes: Object.fromEntries(nodeDefs), edges: [...effectiveEdges] });
  const restoredRuntime = options.restore?.runtime;
  const restoringNested = new Set(Object.keys(restoredRuntime?.nested ?? {}).filter(id => options.restore?.nodes[id]?.status === "running"));
  const instances = graph.version === 2 || restoredRuntime !== undefined || options.onCheckpoint !== undefined
    ? new GraphInstances(options.runId ?? restoredRuntime?.runId ?? randomUUID(), options.allocateInstanceId, restoredRuntime, options.now)
    : undefined;
  if (instances && !restoredRuntime) {
    const collections = options.restore?.collections ?? {};
    const children = new Set(Object.values(collections).flatMap(batch => batch.map(child => child.nodeId)));
    for (const id of Object.keys(graph.nodes)) if (!children.has(id)) instances.add(id, { nodeKey: id });
    for (const [parent, batch] of Object.entries(collections)) batch.forEach((child, itemIndex) => { instances.add(child.nodeId, { nodeKey: parent, parentInstanceId: instances.get(parent).instanceId, itemIndex }); });
  }
  let failedCheckpoint: { error: unknown } | undefined;
  const checkpoint = (): void => {
    if (failedCheckpoint) throw failedCheckpoint.error;
    if (!instances) return;
    instances.state.revision++;
    try {
      const committed: unknown = options.onCheckpoint?.(structuredClone({ ...scheduler.snapshotState(), runtime: instances.state }), effectiveGraph());
      if (committed !== null && typeof committed === "object" && "then" in committed) throw new TypeError("Checkpoint writer must be synchronous");
    } catch (error) {
      failedCheckpoint = { error };
      throw error;
    }
  };
  checkpoint();
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

  // Display identities are separate from scheduler identities. Reserve static IDs,
  // then disambiguate nested and later dynamic rows without changing graph wiring.
  const displayIds = new Map(Object.keys(graph.nodes).map(id => [id, id]));
  const usedDisplayIds = new Set(displayIds.values());
  const allocateDisplayId = (candidate: string): string => {
    let id = candidate;
    for (let suffix = 2; usedDisplayIds.has(id); suffix++) id = `${candidate}#${suffix}`;
    usedDisplayIds.add(id);
    return id;
  };
  const displayId = (id: string): string => {
    let mapped = displayIds.get(id);
    if (mapped === undefined) {
      mapped = allocateDisplayId(id);
      displayIds.set(id, mapped);
    }
    return mapped;
  };
  const nestedIds = new Map<string, Map<string, string>>();
  const registeredNested = new Set<string>();
  const registerNode: NonNullable<RunGraphOptions["onNodeAdded"]> = (id, node, metadata) => {
    if (instances) orderedIds[instances.get(id).ordinal] = id;
    else orderedIds.push(id);
    options.onNodeAdded?.(displayId(id), node, { ...metadata,
      ...(instances ? { ordinal: instances.get(id).ordinal, materializationKey: `${instances.state.runId}/${instances.get(id).instanceId}` } : {}),
      ...(graph.version === 2 && instances ? { instance: instances.get(id) } : {}),
      dependencies: metadata.dependencies.map(displayId) });
  };
  const report = (id: string): void => {
    checkpoint();
    const run = scheduler.nodes.get(id);
    if (run !== undefined) options.onNodeUpdate?.(displayId(id), run);
  };

  const launchAgent = (id: string, node: AgentNode, resources: string[]): void => {
    const evaluation = feedback?.evaluator(id);
    if (evaluation && evaluation.remainingAttempts <= 0) {
      scheduler.settle(id, { ok: false, error: evaluation.error ?? "Evaluator retry budget exhausted" });
      report(id);
      return;
    }
    scheduler.markRunning(id);
    report(id);
    acquire(resources);
    const exec = buildExecInput(id, node, options.host, contextOf(scheduler, input), {
      ...options, onNodeResolved: (nodeId, info) => options.onNodeResolved?.(displayId(nodeId), info),
    });
    if (graph.version === 2 && instances) {
      exec.nodeId = instances.get(id).instanceId;
      exec.attemptOffset = (scheduler.nodes.get(id)?.attempt ?? 1) - 1;
      exec.onAttempt = attempt => { if (attempt > 1) scheduler.markRunning(id); report(id); };
      exec.onCost = (costUsd, attempt) => { scheduler.recordCost(id, costUsd, attempt); checkpoint(); };
    }
    if (evaluation && exec.schema) {
      exec.maxAttempts = evaluation.remainingAttempts;
      exec.onFailure = evaluation.failed;
      const context = contextOf(scheduler, input);
      exec.prompt = interpolate(evaluation.node.evaluator.prompt, { ...evaluation.node.evaluator.input, feedback: { node: id, path: "$" } }, { ...context, outputs: new Map([...context.outputs, [id, evaluation.input]]) });
      const schema = exec.schema;
      exec.schema = { ...schema, check: value => {
        const valid = schema.check(value);
        if (valid !== true) return valid;
        try { decision(value, evaluation.node); return true; }
        catch (error) { if (error instanceof Error) return error.message; throw error; }
      } };
    }
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
        const previousCost = scheduler.nodes.get(id)?.costUsd;
        const costUsd = graph.version === 2 ? previousCost : out.costUsd === undefined ? undefined : (previousCost ?? 0) + out.costUsd;
        return { ok: out.ok, output: parseOutput(node, out), error: out.error, skipped: out.skipped, costUsd };
      },
    });
  };

  const launchSubgraph = (id: string, node: SubgraphNode): void => {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    scheduler.markRunning(id);
    report(id);
    let settle: SettleInput = { ok: false, error: `subgraph node "${id}" did not run` };
    const done = (async (): Promise<string> => {
      const savedChild = restoringNested.delete(id) ? instances?.state.nested?.[id] : undefined;
      const childInput = savedChild?.input ?? resolveInputMap(node.input, contextOf(scheduler, input));
      const loader = options.loadGraph;
      if (loader === undefined && savedChild === undefined) {
        settle = { ok: false, error: `subgraph node "${id}" needs a loadGraph loader, but none was provided` };
        return id;
      }
      const childGraph = savedChild?.graph ?? loader?.(node.graph);
      if (childGraph === undefined) {
        settle = { ok: false, error: `subgraph "${node.graph}" could not be resolved` };
        return id;
      }
      const validation = validateGraph(childGraph);
      if (!validation.ok) {
        settle = { ok: false, error: `subgraph "${node.graph}" is invalid: ${validation.errors.join("; ")}` };
        return id;
      }
      const scope = nestedScope(displayId(id), savedChild ? Number(savedChild.state.runtime?.runId.split("/").at(-1)) : scheduler.nodes.get(id)?.attempt ?? 1);
      const ids = nestedIds.get(scope) ?? new Map<string, string>();
      nestedIds.set(scope, ids);
      const nestedId = (childId: string): string => {
        let mapped = ids.get(childId);
        if (mapped === undefined) {
          mapped = allocateDisplayId(`${scope}/${childId}`);
          ids.set(childId, mapped);
        }
        return mapped;
      };
      const ordinals: Record<string, number> = savedChild?.ordinals ?? Object.create(null);
      const added: NonNullable<RunGraphOptions["onNodeAdded"]> = (childId, child, metadata) => {
        const mapped = nestedId(childId);
        if (!registeredNested.has(mapped)) {
          registeredNested.add(mapped);
          // ponytail: nested rows are observable, not controllable. Reserve their
          // monitor indices; control federation needs a shared scheduler contract.
          if (!instances) orderedIds.push(undefined);
        }
        if (instances) {
          const key = metadata.materializationKey;
          if (!key) throw new TypeError("Missing nested materialization key");
          ordinals[key] ??= instances.reserveOrdinal();
          const ordinal = ordinals[key];
          orderedIds[ordinal] = undefined;
          checkpoint();
          options.onNodeAdded?.(mapped, child, { ...metadata, ordinal,
            ...(metadata.instance ? { instance: { ...metadata.instance, ordinal } } : {}),
            dependencies: metadata.dependencies.map(nestedId),
          });
        } else options.onNodeAdded?.(mapped, child, { ...metadata, dependencies: metadata.dependencies.map(nestedId) });
      };
      if (!instances) for (const [childId, child] of Object.entries(childGraph.nodes)) {
        added(childId, child, {
          dependencies: childGraph.edges.filter(edge => edge.to === childId).map(edge => edge.from),
          ...(child.type === "fanout" && child.phase ? { phase: child.phase } : {}),
        });
      }
      const childResult = await runGraph(childGraph, childInput, {
        ...childOptions(options), signal,
        ...(instances ? {
          runId: savedChild?.state.runtime?.runId ?? `${instances.state.runId}/${instances.get(id).instanceId}/${scheduler.nodes.get(id)?.attempt}`,
          ...(options.allocateInstanceId ? { allocateInstanceId: options.allocateInstanceId } : {}),
          ...(savedChild ? { restore: savedChild.state } : {}),
          onCheckpoint: (state: SchedulerState, definition: AgentGraph) => {
            instances.state.nested ??= Object.create(null);
            const nested = instances.state.nested;
            if (!nested) throw new TypeError("Missing nested checkpoint owner");
            for (const row of nestedMaterializations(definition, state)) ordinals[row.key] ??= instances.reserveOrdinal();
            const prior = nested[id];
            let previous = prior?.previous ?? [];
            if (prior && prior.state.runtime?.runId !== state.runtime?.runId) {
              const { previous: _previous, ...completed } = prior;
              previous = [...previous, structuredClone(completed)];
            }
            nested[id] = { graph: definition, state, ordinals, input: childInput, ...(previous.length ? { previous } : {}) };
            checkpoint();
          },
        } : {}),
        onNodeAdded: added,
        onNodeUpdate: (childId, run) => options.onNodeUpdate?.(nestedId(childId), run),
        onNodeResolved: (childId, info) => options.onNodeResolved?.(nestedId(childId), info),
      });
      settle =
        childResult.status === "completed"
          ? { ok: true, output: childResult.outputs }
          : { ok: false, error: `subgraph "${node.graph}" ${childResult.status}` };
      return id;
    })();
    inflight.set(id, { done, resources: [], stop: () => controller.abort(), result: () => settle });
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
      options.onGateWaiting?.(id, scheduler.snapshotState(), effectiveGraph());
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
    let placed: GraphFragment;
    try {
      // Placement precedes effective-ID validation. Malformed fragment structure
      // can fail rewriting, and must fail this node rather than reject the run.
      placed = namespaceFragment(fragment, node.namespace);
    } catch (error) {
      scheduler.settle(id, { ok: false, error: `expand node "${id}" fragment is invalid: ${error instanceof Error ? error.message : String(error)}` });
      report(id);
      return;
    }
    const validation = validateFragment(placed, scheduler.nodeIds());
    if (!validation.ok) {
      scheduler.settle(id, { ok: false, error: `expand node "${id}" fragment is invalid: ${validation.errors.join("; ")}` });
      report(id);
      return;
    }
    for (const [fid, fnode] of Object.entries(placed.nodes)) {
      nodeDefs.set(fid, fnode);
      instances?.add(fid, { nodeKey: fid, parentInstanceId: instances.get(id).instanceId });
    }
    scheduler.insertFragment(placed);
    effectiveEdges.push(...placed.edges);
    for (const [fid, fnode] of Object.entries(placed.nodes)) {
      registerNode(fid, fnode, { dependencies: placed.edges.filter(edge => edge.to === fid).map(edge => edge.from) });
    }
    scheduler.settle(id, { ok: true, output: {} });
    report(id);
  };

  const launchFanout = (id: string, node: FanoutNode): void => {
    scheduler.markRunning(id);
    report(id);
    // Restored barriers retain ownership; never materialize the same IDs twice.
    if (scheduler.collections.has(id)) return;
    const prepared = prepareFanout(node, contextOf(scheduler, input));
    const fail = (error: string): void => {
      scheduler.settle(id, { ok: false, error: `fanout node "${id}": ${error}` });
      report(id);
    };
    if (!prepared.ok) { fail(prepared.error); return; }
    if (graph.version === 2 && !scheduler.canMaterialize(prepared.items.length)) { fail("total node run limit"); return; }
    if (nodeDefs.size + prepared.items.length > MAX_NODES) {
      fail(`effective graph exceeds the limit of ${MAX_NODES} nodes`);
      return;
    }
    const children = prepared.items.map(({ item }, index) => ({ nodeId: `${id}:item:${index}`, item }));
    for (const child of children) {
      if (nodeDefs.has(child.nodeId)) { fail(`generated id "${child.nodeId}" collides with an existing node`); return; }
    }
    const nodes = Object.fromEntries(prepared.items.map(({ node: child }, index) => [`${id}:item:${index}`, { ...child, ...(node.name !== undefined ? { name: node.name } : {}) }]));
    // Commit ownership and all definitions before callbacks can observe a child.
    scheduler.insertFragment({ nodes, edges: [] });
    scheduler.collections.set(id, children);
    for (const [itemIndex, [childId, child]] of Object.entries(nodes).entries()) {
      nodeDefs.set(childId, child);
      instances?.add(childId, { nodeKey: id, parentInstanceId: instances.get(id).instanceId, itemIndex });
    }
    if (graph.version === 2 && instances) scheduler.collections.set(id, children.map(child => ({ ...child, ...instances.get(child.nodeId) })));
    checkpoint();
    for (const [childId, child] of Object.entries(nodes)) {
      registerNode(childId, child, { dependencies: [], ...(node.phase ? { phase: node.phase } : {}) });
      report(childId);
    }
  };

  const feedback = instances ? new BoundedFeedback({ scheduler, instances, definitions: nodeDefs, edges: effectiveEdges,
    context: () => contextOf(scheduler, input), checkpoint, now: options.now ?? Date.now,
    added: (id, node, dependencies) => { registerNode(id, node, { dependencies }); report(id); },
  }) : undefined;
  for (const [id, state] of Object.entries(feedback?.states ?? {})) {
    if (!state.terminal) {
      const run = scheduler.nodes.get(id);
      if (run) run.status = "running";
    }
  }
  // Undefined slots are nested monitor rows; controls remain direct-graph only.
  const orderedIds: (string | undefined)[] = instances ? [] : Object.keys(graph.nodes);
  if (instances) for (const row of instances.state.manifest) orderedIds[row.ordinal] = row.binding;
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
        wakePause?.();
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
  if (instances) {
    for (const instance of instances.state.manifest) {
      const node = nodeDefs.get(instance.binding);
      if (node) options.onNodeAdded?.(displayId(instance.binding), node, {
        ordinal: instance.ordinal, materializationKey: `${instances.state.runId}/${instance.instanceId}`, ...(graph.version === 2 ? { instance } : {}), dependencies: effectiveEdges.filter(edge => edge.to === instance.binding).map(edge => displayId(edge.from)),
      });
    }
  }
  for (const [id, saved] of Object.entries(instances?.state.nested ?? {})) {
    const status = scheduler.nodes.get(id)?.status;
    const settled = instances?.state.cancelled || status === "completed" || status === "failed" || status === "skipped";
    const rows = settled ? restoredNestedRows(saved, displayId(id)) : (saved.previous ?? []).flatMap(previous => restoredNestedRows(previous, displayId(id)));
    const names = new Map(rows.map(row => [row.id, allocateDisplayId(row.id)]));
    for (const row of rows) {
      const mapped = names.get(row.id);
      if (!mapped) throw new TypeError("Missing nested display binding");
      orderedIds[row.ordinal] = undefined;
      options.onNodeAdded?.(mapped, row.node, { ordinal: row.ordinal, materializationKey: row.key, ...(row.instance ? { instance: row.instance } : {}), dependencies: row.dependencies.map(key => names.get(key) ?? key) });
      options.onNodeUpdate?.(mapped, row.run);
    }
  }
  // Hydration has validated ownership before any restored metadata is exposed.
  if (!instances) for (const [parentId, children] of scheduler.collections) {
    const parent = nodeDefs.get(parentId);
    for (const { nodeId } of children) {
      const child = nodeDefs.get(nodeId);
      if (parent?.type === "fanout" && child !== undefined) {
        options.onNodeAdded?.(displayId(nodeId), child, { dependencies: [], ...(parent.phase ? { phase: parent.phase } : {}) });
      }
    }
  }
  // Seed the monitor from authoritative hydrated state before scheduling. Dynamic
  // expand nodes remain reported only through their runtime transitions.
  for (const id of Object.keys(graph.nodes)) report(id);

  const abortRun = (): RunGraphResult => {
    stopAll();
    const lifecycle = ["reload", "switch", "shutdown"].includes(options.signal?.reason);
    if (!lifecycle) {
      if (instances) instances.state.cancelled = true;
      feedback?.cancel();
    }
    checkpoint();
    return { status: "aborted", outputs: feedback ? scheduler.resolveOutputs() : {}, nodes: snapshotNodes(scheduler), ...(graph.version === 2 && feedback ? { feedback: feedback.terminalResults() } : {}) };
  };

  // Resolves the moment the run is aborted, so the loop unblocks even when an
  // inflight node (e.g. a human_gate whose resolver ignores the signal) never
  // settles — otherwise shutdown would hang on a parked gate.
  const ABORTED = Symbol("aborted");
  const abortRace = new Promise<typeof ABORTED>(resolve => {
    if (options.signal?.aborted) resolve(ABORTED);
    else options.signal?.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });

  try {
  while (true) {
    if (options.signal?.aborted || instances?.state.cancelled) return abortRun();
    for (const id of scheduler.settleCollections()) report(id);
    if (feedback?.tick()) {
      for (const id of Object.keys(feedback.states)) report(id);
      continue;
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
      if (node.type === "bounded_feedback" && feedback) {
        scheduler.markRunning(id);
        feedback.start(id, node);
        report(id);
        progressed = true;
        continue;
      }
      if (node.type === "fanout") {
        launchFanout(id, node);
        progressed = true;
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
    if (settled === ABORTED) return abortRun();
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
    status: scheduler.runStatus(feedback?.handledNodes) === "failed" ? "failed" : "completed",
    outputs: scheduler.resolveOutputs(),
    nodes: snapshotNodes(scheduler),
    ...(graph.version === 2 && feedback ? { feedback: feedback.terminalResults() } : {}),
  };
  } finally {
    stopAll();
  }
}

function snapshotNodes(scheduler: Scheduler): RunGraphResult["nodes"] {
  const nodes: RunGraphResult["nodes"] = {};
  for (const [id, run] of scheduler.nodes) {
    nodes[id] = { ...run };
  }
  return nodes;
}
