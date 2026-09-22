import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decision, decisionSchema, type FeedbackIteration, type FeedbackReason, type FeedbackState, feedbackBudgetBounds, feedbackContinuation, feedbackTerminal } from "./bounded-feedback.js";
import { type CoordinatorReceipt, type CoordinatorRequest, coordinatorReceipt, type FeedbackOwnerView } from "./coordinator-protocol.js";
import { prepareFanout } from "./fanout.js";
import { validateCheckpointTransition } from "./graph-checkpoint-transition.js";
import { matchesExecution, upgradeLegacyExecution } from "./graph-execution.js";
import { GraphExecutions } from "./graph-execution-runtime.js";
import { parseFragment } from "./graph-fragment.js";
import { GraphInstances, type GraphRuntimeState } from "./graph-instance-id.js";
import { nestedMaterializations, nestedScope, restoredNestedRows } from "./graph-nested-checkpoint.js";
import { collectionProposal, hasCapacity, type NodeTransition, restoreProposal, skipProposal, transitionProposal } from "./graph-planner.js";
import { GraphProjection } from "./graph-planning-view.js";
import { applyRecovery } from "./graph-projection.js";
import type { CheckpointFrame, ChildCheckpointRequest, GraphActorInput, GraphAdmission } from "./graph-protocol.js";
import { validateGraphRestore } from "./graph-restore-validation.js";
import { validateSchedulerState } from "./graph-state-validation.js";
import type {
  AgentGraph,
  AgentNode,
  BoundedFeedbackNode,
  ExpandNode,
  FanoutNode,
  FanoutResult,
  GraphFragment,
  GraphNode,
  HumanGateNode,
  NodeId,
  SubgraphNode,
  ValueRef,
} from "./ir.js";
import { compileJsonSchema } from "./json-schema.js";
import type { NodeSpawnResult } from "./node-host.js";
import type { AgentLifecycleInput } from "./node-lifecycle-session.js";
import { admissionReceipt, type NodeAdmissionReceipt, type NodeParentEvent, type NodeRequest } from "./node-protocol.js";
import { coerceGraphInput, DEFAULT_CONCURRENCY, type RunGraphOptions, type RunGraphResult } from "./run-graph.js";
import type { SchedulerState, SettleInput } from "./scheduler.js";
import { requestSubgraphDisposition } from "./subgraph-disposition.js";
import { MAX_NODES, validateGraph, validateLoopBarriers } from "./validate.js";
import { MISSING, type ResolutionContext, resolveValueRef } from "./value-ref.js";

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

/** Parse a completed node's output for the projection: JSON when schema'd, else text. */
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

/** The resolution context over the projection's current completed outputs. */
function contextOf(projection: GraphProjection, input: unknown): ResolutionContext {
  const outputs = new Map<string, unknown>();
  for (const [id, run] of projection.nodes) if (run.status === "completed") outputs.set(id, run.output);
  return { input, outputs };
}


/** Resolve a node's input ValueRefs into a plain object, omitting missing values. */
function resolveInputMap(input: Record<string, ValueRef> | undefined, ctx: ResolutionContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).flatMap(([name, ref]) => {
    const value = resolveValueRef(ref, ctx);
    return value === MISSING ? [] : [[name, value]];
  }));
}

/** The options a subgraph node passes down to its child run (loader/resources/signal shared). */
function childOptions(options: RunGraphOptions): RunGraphOptions {
  const child: RunGraphOptions = { host: options.host, now: options.now, authorizeAgent: options.authorizeAgent, reclaimedDeadWriter: options.reclaimedDeadWriter };
  if (options.concurrency !== undefined) child.concurrency = options.concurrency;
  if (options.signal !== undefined) child.signal = options.signal;
  if (options.loadGraph !== undefined) child.loadGraph = options.loadGraph;
  if (options.resources !== undefined) child.resources = options.resources;
  return child;
}


/** Bounded Panda transactions only. Every mutating operation is called by a root-machine action. */
// allow: SIZE_OK — root-selected projection transactions share topology/feedback closure state; coordinator actors own volatile sequencing.
export function createGraphDomain(source: GraphActorInput, owned: () => readonly string[] = () => []) {
  const { graph, options, depth } = source;
  let input = source.input;
  assertGraphDepth(options.restore, depth);
  if (graph.version !== undefined && graph.version !== 1 && graph.version !== 2) throw new TypeError("Unsupported graph version");
  if (graph.version !== 2 && Object.values(graph.nodes).some(node => node.type === "bounded_feedback")) throw new TypeError("Bounded feedback requires version 2");
  if ((graph.version === 2 || options.restore?.runtime !== undefined) && !options.onCheckpoint && depth === 0) throw new TypeError("Version 2 requires a durable checkpoint writer");
  if (graph.version === 2 && !options.restore) {
    const validation = validateGraph(graph);
    if (!validation.ok) throw new TypeError(validation.errors.join("; "));
  }
  if (graph.version === 2 && options.restore && !options.restore.runtime) throw new TypeError("Missing v2 restore manifest");
  input = coerceGraphInput(input);
  if (options.restore) {
    if (options.restore.runtime) validateGraphRestore(options.restore, graph, input);
    else validateSchedulerState(options.restore, graph);
  }
  const effectiveEdges = [...graph.edges];
  const projection = new GraphProjection({ ...graph, edges: effectiveEdges }, input, options.restore);
  if (options.restore) projection.apply(restoreProposal(projection.state));
  const transition = (intent: NodeTransition): void => projection.apply(transitionProposal(projection.view(), intent));
  const complete = (id: string, result: SettleInput): void => transition({ kind: "settle", id, result });
  const materialize = (fragment: GraphFragment): void => {
    projection.apply({ kind: "materialize", ids: Object.keys(fragment.nodes) }); effectiveEdges.push(...fragment.edges);
  };
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  // Node definitions grow at runtime when an expand node splices a fragment in.
  const nodeDefs = new Map<NodeId, GraphNode>(Object.entries(graph.nodes));
  const effectiveGraph = (): AgentGraph => ({ ...graph, nodes: Object.fromEntries(nodeDefs), edges: [...effectiveEdges] });
  const restoredRuntime = options.restore?.runtime;
  const restoringNested = new Set(Object.entries(restoredRuntime?.nested ?? {}).filter(([id, child]) => { const run = options.restore?.nodes[id]; return child.state.runtime?.runId.endsWith(`/${run?.attempt}`) && (run?.status === "running" || run?.status === "pending" && !run.attemptReason); }).map(([id]) => id));
  const durable = graph.version === 2 || restoredRuntime !== undefined || options.onCheckpoint !== undefined;
  const instances = new GraphInstances(options.runId ?? restoredRuntime?.runId ?? randomUUID(), options.allocateInstanceId, restoredRuntime, options.now);
  if (instances && !restoredRuntime) {
    const collections = options.restore?.collections ?? {};
    const children = new Set(Object.values(collections).flatMap(batch => batch.map(child => child.nodeId)));
    for (const id of Object.keys(graph.nodes)) if (!children.has(id)) instances.add(id, { nodeKey: id });
    for (const [parent, batch] of Object.entries(collections)) batch.forEach((child, itemIndex) => { instances.add(child.nodeId, { nodeKey: parent, parentInstanceId: instances.get(parent).instanceId, itemIndex }); });
  }
  const protocolRuntime: GraphRuntimeState = instances.state;
  projection.state.runtime = protocolRuntime;
  if (protocolRuntime.executionProtocolVersion !== 1) {
    const upgraded = options.restore ? upgradeLegacyExecution({ ...options.restore, runtime: protocolRuntime }).runtime : { executionProtocolVersion: 1 as const, executionLedger: [] };
    if (!upgraded) throw new TypeError("Missing upgraded execution runtime");
    Object.assign(protocolRuntime, { executionProtocolVersion: upgraded.executionProtocolVersion, executionLedger: upgraded.executionLedger });
  }
  const executions = new GraphExecutions(protocolRuntime, projection.nodes);
  const restoringStarts = new Set(Object.entries(options.restore?.nodes ?? {}).filter(([id, run]) => {
    if (run.status === "running") return true;
    if (run.status !== "pending" || run.attempt === 0) return false;
    const current = executions.current(id);
    // A prior restart label is presentation, not authority to mint another budget scope.
    return current ? !executions.rows(current).some(row => row.payload.kind === "outcome" && row.payload.status === "success") : !run.attemptReason;
  }).map(([id]) => id));
  const startNode = (id: string): void => {
    transition({ kind: "start", id, restored: restoringStarts.delete(id), executionIdentity: true });
  };
  const frames: CheckpointFrame[] = [];
  const publications: (() => void)[] = [];
  const publish = (callback: () => void): void => {
    if (publications.length >= MAX_NODES * 4) throw new TypeError("Graph publication queue exceeded its bound");
    publications.push(callback);
  };
  const checkpoint = (): void => {
    executions.flush(); normalizeFeedbackSkips(); instances.state.revision++;
    frames.push({ state: structuredClone({ ...projection.snapshotState(), runtime: instances.state }), graph: effectiveGraph(), input, publications: [] });
  };
  const orderedIds: (string | undefined)[] = durable ? [] : Object.keys(graph.nodes);
  if (durable) for (const row of instances.state.manifest) orderedIds[row.ordinal] = row.binding;
  // Display identities are separate from projection identities. Reserve static IDs,
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
    if (durable) orderedIds[instances.get(id).ordinal] = id;
    else orderedIds.push(id);
    publish(() => options.onNodeAdded?.(displayId(id), node, { ...metadata,
      ...(durable ? { ordinal: instances.get(id).ordinal, materializationKey: `${instances.state.runId}/${instances.get(id).instanceId}` } : {}),
      ...(graph.version === 2 && instances ? { instance: instances.get(id) } : {}),
      dependencies: metadata.dependencies.map(displayId) }));
  };
  const report = (id: string): void => {
    const run = projection.nodes.get(id);
    if (run !== undefined) { const copy = { ...run }; const identity = executions.current(id); publish(() => options.onNodeUpdate?.(displayId(id), copy, identity)); }
  };

  let coordinatorCancellation: "cancel" | "lifecycle" | undefined;
  const coordinatorIdentity = (id: string, incarnation: string): CoordinatorReceipt => {
    const run = projection.nodes.get(id);
    const kind = nodeDefs.get(id)?.type;
    if ((kind !== "expand" && kind !== "fanout" && kind !== "bounded_feedback" && kind !== "graph") || run?.activation === undefined || run.graphAttempt === undefined) throw new TypeError("Missing coordinator identity");
    return coordinatorReceipt({ kind, id, incarnation, runId: instances.state.runId, instanceId: instances.get(id).instanceId,
      activation: run.activation, graphAttempt: run.graphAttempt, attempt: run.attempt });
  };
  const admitExpand = (id: string, node: ExpandNode): GraphAdmission => {
    if (projection.nodes.get(id)?.status !== "running") startNode(id);
    report(id);
    const source = resolveValueRef(node.source, contextOf(projection, input));
    return { kind: "expand", id, input: { receipt: coordinatorIdentity(id, randomUUID()), source: source === MISSING ? undefined : source, namespace: node.namespace, existingIds: [...projection.nodeIds()] } };
  };
  const collectionView = (id: string) => {
    const children = projection.collections.get(id);
    return { revision: instances.state.revision, materialized: children !== undefined,
      ready: children?.every(child => { const status = projection.nodes.get(child.nodeId)?.status; return status === "completed" || status === "failed" || status === "skipped"; }) ?? false,
      settled: projection.nodes.get(id)?.status !== "running" };
  };
  const admitFanout = (id: string): GraphAdmission => {
    if (projection.nodes.get(id)?.status !== "running") startNode(id);
    report(id);
    return { kind: "fanout", id, input: { receipt: coordinatorIdentity(id, randomUUID()), view: collectionView(id) } };
  };
  /** Root-selected atomic topology transaction; preparation is never collision authority. */
  const coordinatorRequest = (request: CoordinatorRequest): Readonly<Record<string, number>> | undefined => {
    const { receipt, operation } = request; const id = receipt.id;
    if (!isDeepStrictEqual(receipt, coordinatorIdentity(id, receipt.incarnation)) || (!coordinatorCancellation && projection.nodes.get(id)?.status !== "running")) throw new TypeError("Stale coordinator transaction identity");
    if (operation.kind === "nested-checkpoint" || operation.kind === "nested-settlement") {
      if (receipt.kind !== "graph") throw new TypeError("Invalid subgraph coordinator request");
      const nested = operation.kind === "nested-checkpoint" ? operation.request : operation.result;
      if (nested.id !== id || nested.invocation !== childInvocation(id)) throw new TypeError("Stale nested coordinator invocation");
      if (operation.kind === "nested-checkpoint") return acceptNested(operation.request);
      if (operation.result.failure) throw operation.result.failure.error;
      settleGraph(id, operation.result.result); checkpoint(); return;
    }
    if (coordinatorCancellation) {
      if (coordinatorCancellation === "cancel" && projection.nodes.get(id)?.status === "running") complete(id, { ok: false, skipped: true });
    } else {
      switch (operation.kind) {
        case "feedback-intent": {
          const node = feedbackNode(id);
          if (receipt.kind !== "bounded_feedback" || feedbackStates[id]) throw new TypeError("Invalid feedback intent request");
          const prepared = prepareFanout(node.work, contextOf(projection, input));
          feedbackStates[id] = { iterations: [], gaps: [] };
          if (!prepared.ok) finishFeedback(id, "materialization failure", [prepared.error]);
          else {
            feedbackStates[id].intent = { iteration: 1, tasks: prepared.items.map(item => item.item) };
            feedbackBudgetExceeded(id, node);
          }
          break;
        }
        case "feedback-materialize":
          if (receipt.kind !== "bounded_feedback" || feedbackStates[id]?.intent?.iteration !== operation.iteration) throw new TypeError("Invalid feedback materialization request");
          materializeFeedback(id, feedbackNode(id)); break;
        case "feedback-decision":
          if (receipt.kind !== "bounded_feedback" || feedbackStates[id]?.active?.iteration !== operation.iteration || feedbackView(id).phase !== "decision") throw new TypeError("Invalid feedback decision request");
          decideFeedback(id, feedbackNode(id)); break;
        case "materialize": {
          const node = nodeDefs.get(id);
          if (receipt.kind !== "fanout" || node?.type !== "fanout" || projection.collections.has(id)) throw new TypeError("Invalid fanout materialization request");
          materializeFanout(id, node); break;
        }
        case "aggregate": {
          if (receipt.kind !== "fanout" || !collectionView(id).ready) throw new TypeError("Collection is not ready for aggregation");
          const proposal = collectionProposal({ ...projection.view(), collectionOrder: [id] });
          if (!proposal.completed.includes(id)) throw new TypeError("Missing collection settlement");
          projection.apply(proposal.intent); break;
        }
        case "insert": {
          if (receipt.kind !== "expand") throw new TypeError("Invalid expansion request");
          let placed: GraphFragment;
          try {
            placed = parseFragment(operation.fragment, projection.nodeIds());
            const errors = validateLoopBarriers({ ...Object.fromEntries(nodeDefs), ...placed.nodes }, [...effectiveEdges, ...placed.edges]);
            if (errors.length) throw new TypeError(errors.join("; "));
          }
          catch (error) {
            complete(id, { ok: false, error: `expand node "${id}" fragment is invalid: ${error instanceof Error ? error.message : String(error)}` });
            break;
          }
          for (const [fid, fnode] of Object.entries(placed.nodes)) {
            nodeDefs.set(fid, fnode);
            instances.add(fid, { nodeKey: fid, parentInstanceId: instances.get(id).instanceId });
          }
          materialize(placed);
          complete(id, { ok: true, output: {} });
          for (const [fid, fnode] of Object.entries(placed.nodes)) registerNode(fid, fnode, { dependencies: placed.edges.filter(edge => edge.to === fid).map(edge => edge.from) });
          break;
        }
        case "fail": complete(id, { ok: false, error: operation.error }); break;
        case "cancel": throw new TypeError("Coordinator cancellation was not persisted");
        default: { const exhaustive: never = operation; throw new TypeError(`Unknown coordinator operation: ${exhaustive}`); }
      }
    }
    checkpoint(); report(id);
  };

  /** Atomic materialization selected exclusively by a COORD request. */
  const materializeFanout = (id: string, node: FanoutNode): void => {
    const prepared = prepareFanout(node, contextOf(projection, input));
    const fail = (error: string): void => {
      complete(id, { ok: false, error: `fanout node "${id}": ${error}` });
      report(id);
    };
    if (!prepared.ok) { fail(prepared.error); return; }
    if (graph.version === 2 && !projection.canMaterialize(prepared.items.length)) { fail("total node run limit"); return; }
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
    materialize({ nodes, edges: [] });
    projection.apply({ kind: "collection", id, children });
    for (const [itemIndex, [childId, child]] of Object.entries(nodes).entries()) {
      nodeDefs.set(childId, child);
      instances?.add(childId, { nodeKey: id, parentInstanceId: instances.get(id).instanceId, itemIndex });
    }
    if (graph.version === 2 && instances) projection.apply({ kind: "collection", id, children: children.map(child => ({ ...child, ...instances.get(child.nodeId) })) });
    for (const [childId, child] of Object.entries(nodes)) {
      registerNode(childId, child, { dependencies: [], ...(node.phase ? { phase: node.phase } : {}) });
      report(childId);
    }
  };

  const feedbackStates: Record<string, FeedbackState> = Object.assign(Object.create(null), instances.state.feedback);
  instances.state.feedback = feedbackStates;
  const feedbackNode = (id: string): BoundedFeedbackNode => {
    const node = nodeDefs.get(id);
    if (node?.type !== "bounded_feedback") throw new TypeError("Missing feedback template");
    return node;
  };
  const feedbackResults = (work: string): FanoutResult["results"] => (projection.collections.get(work) ?? []).map((child, index) => {
    const run = projection.nodes.get(child.nodeId);
    return { ...child, ...instances.get(child.nodeId), index, status: run?.status === "completed" ? "completed" : run?.status === "failed" ? "failed" : "skipped", attempt: run?.attempt ?? 0, ...(run?.output !== undefined ? { output: run.output } : {}), ...(run?.error !== undefined ? { error: run.error } : {}) };
  });
  const finishFeedback = (id: string, reason: FeedbackReason, exhaustedBounds: readonly string[] = []): void => {
    const state = feedbackTerminal(feedbackStates[id], reason, exhaustedBounds);
    feedbackStates[id] = state;
    const skipped = reason === "skipped before admission" || (reason === "cancellation" && projection.nodes.get(id)?.attempt === 0);
    complete(id, { ok: reason !== "materialization failure", skipped, output: state.terminal, ...(reason === "materialization failure" ? { error: exhaustedBounds.join("; ") || reason } : {}) });
  };
  const normalizeFeedbackSkips = (): void => {
    for (const [id, node] of nodeDefs) {
      if (node.type !== "bounded_feedback" || feedbackStates[id] || projection.nodes.get(id)?.status !== "skipped") continue;
      feedbackStates[id] = { iterations: [], gaps: [] }; finishFeedback(id, "skipped before admission");
    }
  };
  const feedbackBudgetExceeded = (id: string, node: BoundedFeedbackNode): boolean => {
    if (node.deadline === undefined && node.spendLimit === undefined) return false;
    const state = feedbackStates[id]; const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid feedback budget clock");
    state.budgetCheckedAt = Math.max(now, instances.state.startedAt ?? 0, state.budgetCheckedAt ?? 0);
    const bounds = feedbackBudgetBounds(state, node, instances.state.startedAt ?? 0, projection.nodes, state.budgetCheckedAt, instances.state);
    if (!bounds.length) return false;
    finishFeedback(id, "deadline/spend limit", bounds); return true;
  };
  const feedbackView = (id: string): FeedbackOwnerView => {
    const state = feedbackStates[id];
    const terminal = (binding: string): boolean => ["completed", "failed", "skipped"].includes(projection.nodes.get(binding)?.status ?? "");
    return { revision: instances.state.revision, iteration: state?.intent?.iteration ?? state?.active?.iteration ?? state?.iterations.length ?? 0,
      phase: !state ? "absent" : state.terminal ? "terminal" : state.intent ? "intent" : state.active && !terminal(state.active.work) ? "work" : state.active && !terminal(state.active.evaluator) ? "evaluation" : "decision" };
  };
  const admitFeedback = (id: string): GraphAdmission => {
    if (projection.nodes.get(id)?.status !== "running") startNode(id);
    report(id);
    return { kind: "feedback", id, input: { receipt: coordinatorIdentity(id, randomUUID()), view: feedbackView(id) } };
  };
  const materializeFeedback = (id: string, node: BoundedFeedbackNode): void => {
    const state = feedbackStates[id];
    const intent = state.intent;
    if (!intent) return;
    if (feedbackBudgetExceeded(id, node)) return;
    if (intent.iteration > node.maxIterations) { finishFeedback(id, "iteration limit", ["maxIterations"]); return; }
    const total = state.iterations.reduce((sum, row) => sum + row.tasks.length, 0) + intent.tasks.length;
    if (intent.tasks.length > node.maxItemsPerIteration || total > node.maxTotalItems) { finishFeedback(id, "item limit", [intent.tasks.length > node.maxItemsPerIteration ? "maxItemsPerIteration" : "maxTotalItems"]); return; }
    const count = intent.tasks.length + 2;
    if (nodeDefs.size + count > MAX_NODES || !projection.canMaterialize(count)) { finishFeedback(id, "materialization failure", [nodeDefs.size + count > MAX_NODES ? "node limit" : "run limit"]); return; }
    const work = `${id}:iteration:${intent.iteration}:work`;
    const evaluator = `${id}:iteration:${intent.iteration}:evaluator`;
    const context = contextOf(projection, input);
    const prepared = prepareFanout({ ...node.work, items: { node: work, path: "$" } }, { ...context, outputs: new Map([...context.outputs, [work, intent.tasks]]) });
    if (!prepared.ok) { finishFeedback(id, "materialization failure", [prepared.error]); return; }
    const nodes: Record<string, GraphNode> = { [work]: node.work, [evaluator]: { ...node.evaluator, input: { ...node.evaluator.input, feedback: { path: "$" } }, outputSchema: decisionSchema(node.work.itemSchema) } };
    prepared.items.forEach(({ node: child }, index) => { nodes[`${work}:item:${index}`] = { ...child, ...(node.work.name !== undefined ? { name: node.work.name } : {}) }; });
    if (Object.keys(nodes).some(key => nodeDefs.has(key))) { finishFeedback(id, "materialization failure", ["Generated binding collision"]); return; }
    const parentInstanceId = instances.get(id).instanceId;
    const workInstance = instances.add(work, { nodeKey: id, parentInstanceId, iteration: intent.iteration });
    const evaluatorInstance = instances.add(evaluator, { nodeKey: id, parentInstanceId, iteration: intent.iteration });
    const children = prepared.items.map(({ item }, itemIndex) => {
      const nodeId = `${work}:item:${itemIndex}`;
      const provenance = instances.add(nodeId, { nodeKey: id, parentInstanceId: workInstance.instanceId, iteration: intent.iteration, itemIndex });
      return { nodeId, item, ...provenance };
    });
    const edges = [{ from: work, to: evaluator }];
    for (const [key, definition] of Object.entries(nodes)) nodeDefs.set(key, definition);
    materialize({ nodes, edges }); startNode(work);
    projection.apply({ kind: "collection", id: work, children });
    state.retryFailures = 0;
    delete state.retryError;
    state.active = { iteration: intent.iteration, tasks: intent.tasks, work, evaluator, workInstanceId: workInstance.instanceId, evaluatorInstanceId: evaluatorInstance.instanceId };
    delete state.intent;
    for (const [key, definition] of Object.entries(nodes)) { registerNode(key, definition, { dependencies: key === evaluator ? [work] : [] }); report(key); }
  };
  const decideFeedback = (id: string, node: BoundedFeedbackNode): void => {
    const state = feedbackStates[id]; const active = state.active;
    if (!active) throw new TypeError("Missing active feedback iteration");
    const evaluator = projection.nodes.get(active.evaluator);
    if (!evaluator) throw new TypeError("Missing feedback evaluator");
    const parsed = evaluator.status === "completed" ? decision(evaluator.output, node) : undefined;
    const iteration: FeedbackIteration = { ...active, results: feedbackResults(active.work), ...(parsed ? { decision: parsed } : { evaluatorError: evaluator.error ?? "Evaluator skipped" }) };
    state.iterations.push(structuredClone(iteration)); delete state.active;
    if (parsed) state.gaps = parsed.gaps;
    if (feedbackBudgetExceeded(id, node)) return;
    if (!parsed) { finishFeedback(id, "evaluator failure"); return; }
    const next = feedbackContinuation(state.iterations, node);
    if ("reason" in next) { finishFeedback(id, next.reason, next.exhaustedBounds); return; }
    state.intent = { iteration: active.iteration + 1, tasks: next.tasks };
  };
  const cancelFeedback = (): void => {
    for (const [id, node] of nodeDefs) {
      if (node.type !== "bounded_feedback") continue;
      feedbackStates[id] ??= { iterations: [], gaps: [] };
      const state = feedbackStates[id]; if (state.terminal) continue;
      if (state.active) {
        for (const binding of [state.active.evaluator, ...(projection.collections.get(state.active.work) ?? []).map(child => child.nodeId)]) {
          const run = projection.nodes.get(binding);
          if (run?.status === "pending" || run?.status === "running") complete(binding, { ok: false, skipped: true, error: "Cancellation" });
        }
        projection.apply(collectionProposal({ ...projection.view(), collectionOrder: [state.active.work] }).intent);
        state.iterations.push({ ...state.active, results: feedbackResults(state.active.work) });
      }
      finishFeedback(id, "cancellation");
    }
  };
  const evaluationFor = (id: string) => {
    const parent = Object.keys(feedbackStates).find(parent => feedbackStates[parent].active?.evaluator === id);
    if (parent === undefined) return undefined;
    const state = feedbackStates[parent]; const active = state.active;
    if (!active) throw new TypeError("Missing active evaluator");
    return { node: feedbackNode(parent), input: { iterations: [...state.iterations, { ...active, results: feedbackResults(active.work) }], gaps: state.gaps } };
  };
  const recordFeedbackFailure = (id: string, error: string): void => {
    const state = Object.values(feedbackStates).find(state => state.active?.evaluator === id);
    if (state) Object.assign(state, { retryFailures: (state.retryFailures ?? 0) + 1, retryError: error });
  };

  const initializePublications = (): void => {
  if (durable) {
    for (const instance of instances.state.manifest) {
      const node = nodeDefs.get(instance.binding);
      if (node) publish(() => options.onNodeAdded?.(displayId(instance.binding), node, {
        ordinal: instance.ordinal, materializationKey: `${instances.state.runId}/${instance.instanceId}`, ...(graph.version === 2 ? { instance } : {}), dependencies: effectiveEdges.filter(edge => edge.to === instance.binding).map(edge => displayId(edge.from)),
      }));
    }
  }
  for (const [id, saved] of Object.entries(instances?.state.nested ?? {})) {
    const status = projection.nodes.get(id)?.status;
    const settled = instances?.state.cancelled || status === "completed" || status === "failed" || status === "skipped";
    const rows = settled ? restoredNestedRows(saved, displayId(id)) : (saved.previous ?? []).flatMap(previous => restoredNestedRows(previous, displayId(id)));
    const names = new Map(rows.map(row => [row.id, allocateDisplayId(row.id)]));
    for (const row of rows) {
      const mapped = names.get(row.id);
      if (!mapped) throw new TypeError("Missing nested display binding");
      orderedIds[row.ordinal] = undefined;
      publish(() => options.onNodeAdded?.(mapped, row.node, { ordinal: row.ordinal, materializationKey: row.key, ...(row.instance ? { instance: row.instance } : {}), dependencies: row.dependencies.map(key => names.get(key) ?? key) }));
      publish(() => options.onNodeUpdate?.(mapped, row.run));
    }
  }
  // Hydration has validated ownership before any restored metadata is exposed.
  if (!durable) for (const [parentId, children] of projection.collections) {
    const parent = nodeDefs.get(parentId);
    for (const { nodeId } of children) {
      const child = nodeDefs.get(nodeId);
      if (parent?.type === "fanout" && child !== undefined) {
        publish(() => options.onNodeAdded?.(displayId(nodeId), child, { dependencies: [], ...(parent.phase ? { phase: parent.phase } : {}) }));
      }
    }
  }
  // Seed the monitor from authoritative hydrated state before scheduling. Dynamic
  // expand nodes remain reported only through their runtime transitions.
  for (const id of Object.keys(graph.nodes)) report(id);

  };
  const childInvocation = (id: string): string => `${instances.state.runId}/${instances.get(id).instanceId}/${projection.nodes.get(id)?.attempt}`;
  const resourceNames = (id: string): readonly string[] => {
    const correlation = executions.current(id);
    const admitted = correlation && executions.rows(correlation).find(row => row.payload.kind === "admitted")?.payload;
    return admitted?.kind === "admitted" ? admitted.resources : [];
  };
  const running = (): string[] => [...new Set([...owned().filter(id => ["agent", "human_gate", "graph"].includes(nodeDefs.get(id)?.type ?? "")), ...[...projection.nodes].filter(([id, run]) => run.status === "running" && ["agent", "human_gate", "graph"].includes(nodeDefs.get(id)?.type ?? "")).map(([id]) => id)])];
  const canAdmit = (resources: readonly string[]): boolean => resources.every(name => {
    const capacity = options.resources?.[name]?.capacity;
    return hasCapacity(running().filter(id => resourceNames(id).includes(name)).length, capacity);
  });
  const subgraph = (id: string, node: SubgraphNode): GraphAdmission | undefined => {
    if (depth >= 32) throw new TypeError("Graph nesting exceeds depth 32");
    const saved = restoringNested.delete(id) ? instances.state.nested?.[id] : undefined;
    const childGraph = saved?.graph ?? options.loadGraph?.(node.graph);
    const fail = (error: string): undefined => { complete(id, { ok: false, error }); report(id); return undefined; };
    if (!childGraph) return fail(`subgraph "${node.graph}" could not be resolved; needs a loadGraph loader`);
    const validation = saved ? { ok: true, errors: [] } : validateGraph(childGraph);
    if (!validation.ok) return fail(`subgraph "${node.graph}" is invalid: ${validation.errors.join("; ")}`);
    const childInput = saved?.input ?? resolveInputMap(node.input, contextOf(projection, input));
    const scope = nestedScope(displayId(id), projection.nodes.get(id)?.attempt ?? 1);
    const ids = nestedIds.get(scope) ?? new Map<string, string>(); nestedIds.set(scope, ids);
    const nestedId = (childId: string): string => {
      let mapped = ids.get(childId);
      if (mapped === undefined) { mapped = allocateDisplayId(`${scope}/${childId}`); ids.set(childId, mapped); }
      return mapped;
    };
    const added: NonNullable<RunGraphOptions["onNodeAdded"]> = (childId, child, metadata) => {
      const mapped = nestedId(childId);
      if (!registeredNested.has(mapped)) { registeredNested.add(mapped); if (!durable) orderedIds.push(undefined); }
      const ordinals = instances.state.nested?.[id]?.ordinals;
      const ordinal = metadata.materializationKey ? ordinals?.[metadata.materializationKey] : undefined;
      if (durable && ordinal === undefined) throw new TypeError("Missing committed nested ordinal");
      if (ordinal !== undefined) orderedIds[ordinal] = undefined;
      options.onNodeAdded?.(mapped, child, { ...metadata, ...(ordinal !== undefined ? { ordinal, ...(metadata.instance ? { instance: { ...metadata.instance, ordinal } } : {}) } : {}), dependencies: metadata.dependencies.map(nestedId) });
    };
    return { kind: "graph", id, input: { receipt: coordinatorIdentity(id, randomUUID()), child: { graph: childGraph, input: childInput, depth: depth + 1,
      parent: { id, invocation: childInvocation(id) }, options: { ...childOptions(options), signal: undefined,
        runId: childInvocation(id), ...(options.allocateInstanceId ? { allocateInstanceId: options.allocateInstanceId } : {}),
        ...(saved ? { restore: saved.state } : {}), onCheckpoint: () => {},
        onNodeAdded: added, onNodeUpdate: (childId, run, identity) => options.onNodeUpdate?.(nestedId(childId), run, identity),
        onNodeResolved: (childId, info, identity) => options.onNodeResolved?.(nestedId(childId), info, identity),
      } } } };
  };
  const admit = (id: string, node: AgentNode | HumanGateNode): GraphAdmission | undefined => {
    const denied = node.type === "agent" ? options.authorizeAgent?.(node.agent) : !options.host.awaitHumanGate ? "This host cannot await human input" : undefined;
    if (denied) { complete(id, { ok: false, error: denied }); report(id); return undefined; }
    startNode(id);
    const correlation = executions.begin(id, node);
    if (!correlation) { complete(id, { ok: false, error: "Execution budget exhausted" }); report(id); return undefined; }
    report(id);
    const receipt = admissionReceipt({ id, incarnation: randomUUID(), correlation, executionSequence: executions.index.consumed(correlation) });
    if (node.type === "human_gate") {
      const prompt = interpolate(node.prompt, node.input, contextOf(projection, input));
      const compiled = compileJsonSchema(node.outputSchema);
      const { runtime: _runtime, ...state } = projection.snapshotState(); const definition = effectiveGraph();
      publish(() => options.onGateWaiting?.(id, state, definition));
      return { kind: "human", id, input: { receipt, host: options.host, node: { kind: "human", nodeId: id, prompt, ...(compiled.ok ? { schema: compiled.compiled } : {}) } } };
    }
    const compiled = node.outputSchema === undefined ? undefined : compileJsonSchema(node.outputSchema);
    const exec: { -readonly [Key in keyof AgentLifecycleInput["node"]]: AgentLifecycleInput["node"][Key] } = {
      kind: "agent", nodeId: graph.version === 2 ? instances.get(id).instanceId : id,
      agentType: node.agent, prompt: interpolate(node.prompt, node.input, contextOf(projection, input)),
      maxAttempts: node.retry?.maxAttempts ?? 1, gate: node.validation?.gate,
      ...(compiled?.ok ? { schema: compiled.compiled } : {}),
    };
    const evaluation = evaluationFor(id);
    if (evaluation && exec.schema) {
      const context = contextOf(projection, input);
      exec.prompt = interpolate(evaluation.node.evaluator.prompt, { ...evaluation.node.evaluator.input, feedback: { node: id, path: "$" } }, { ...context, outputs: new Map([...context.outputs, [id, evaluation.input]]) });
      const schema = exec.schema;
      exec.schema = { ...schema, check: value => {
        const valid = schema.check(value); if (valid !== true) return valid;
        try { decision(value, evaluation.node); return true; }
        catch (error) { if (error instanceof Error) return error.message; throw error; }
      } };
    }
    return { kind: "agent", id, input: { receipt, host: options.host, authorize: () => options.authorizeAgent?.(node.agent), node: exec } };
  };
  const plan = (): GraphAdmission[] => {
    const wave: GraphAdmission[] = [];
    let changed = false;
    const ownedIds = new Set(owned());
    const restoredCoordinators = [...projection.nodes].filter(([id, run]) => ["expand", "fanout", "bounded_feedback"].includes(nodeDefs.get(id)?.type ?? "") && run.status === "running" && !ownedIds.has(id)).map(([id]) => id);
    let executorFull = false;
    for (const id of [...restoredCoordinators, ...projection.ready()]) {
      if (ownedIds.has(id)) continue;
      const node = nodeDefs.get(id);
      if (!node) throw new TypeError(`Missing definition ${id}`);
      if (node.type !== "expand" && node.type !== "fanout" && node.type !== "bounded_feedback") {
        executorFull ||= !hasCapacity(running().length, concurrency);
        if (executorFull) continue;
      }
      if (!canAdmit(node.type === "agent" ? node.resources ?? [] : [])) continue;
      changed = true;
      switch (node.type) {
        case "agent": case "human_gate": { const admission = admit(id, node); if (admission) wave.push(admission); break; }
        case "graph": { startNode(id); report(id); const admission = subgraph(id, node); if (admission) wave.push(admission); break; }
        case "bounded_feedback": wave.push(admitFeedback(id)); break;
        case "fanout": wave.push(admitFanout(id)); break;
        case "expand": wave.push(admitExpand(id, node)); break;
      }
    }
    if (changed) checkpoint();
    if (!owned().length && !running().length && !changed && !projection.isDone()) {
      const skips = skipProposal(projection.view());
      const selected = skips.skipped.length ? skips : skipProposal(projection.view(), true);
      projection.apply(selected);
      const changed = selected.skipped;
      if (changed.length) { checkpoint(); for (const id of changed) report(id); }
    }
    return wave;
  };
  const disposition = (id: string): string | undefined => {
    if (nodeDefs.get(id)?.type === "graph") return instances.state.subgraphDispositions?.slice().reverse().find(row => row.instanceId === instances.get(id).instanceId && row.attempt === projection.nodes.get(id)?.attempt)?.reason;
    const current = executions.current(id);
    const payload = current && executions.rows(current).find(row => row.payload.kind === "cancel-requested")?.payload;
    return payload?.kind === "cancel-requested" ? payload.reason : undefined;
  };
  const controlCandidate = (index: number, reason: "skip" | "retry"): string | undefined => {
    const id = orderedIds[index]; if (id === undefined) return undefined;
    const run = projection.nodes.get(id);
    if (reason === "skip" && run?.status === "pending") return id;
    const intent = disposition(id);
    if (nodeDefs.get(id)?.type !== "graph" && intent === undefined) {
      const current = executions.current(id);
      if (!current || !executions.accepts(id, current)) return undefined;
    }
    return run?.status === "running" && running().includes(id) && (intent === undefined || intent === reason) ? id : undefined;
  };
  const control = (index: number, reason: "skip" | "retry"): string | undefined => {
    const id = orderedIds[index]; if (id === undefined) return undefined;
    const run = projection.nodes.get(id);
    if (reason === "skip" && run?.status === "pending") { complete(id, { ok: false, skipped: true }); checkpoint(); report(id); return id; }
    if (run?.status !== "running" || !running().includes(id)) return undefined;
    if (nodeDefs.get(id)?.type === "graph") {
      if (run.activation === undefined || run.graphAttempt === undefined) throw new TypeError("Missing subgraph identity");
      if (!requestSubgraphDisposition(instances.state, { runId: instances.state.runId, instanceId: instances.get(id).instanceId, activation: run.activation, graphAttempt: run.graphAttempt, attempt: run.attempt, reason })) return undefined;
    } else if (!executions.cancel(id, reason)) return undefined;
    checkpoint(); return id;
  };
  const nodeRequest = (request: NodeRequest, receipt: NodeAdmissionReceipt): NodeAdmissionReceipt => {
    const { id, correlation, operation } = request;
    const node = nodeDefs.get(id); const current = executions.current(id);
    if (!node || !current || !matchesExecution(current, correlation) || !matchesExecution(receipt.correlation, correlation) || receipt.id !== id || receipt.incarnation !== request.incarnation) throw new TypeError("Stale node transaction identity");
    const intent = disposition(id);
    switch (operation.kind) {
      case "gate":
        if (node.type !== "agent" || executions.rows(current).some(row => row.payload.kind === "drain-ack")) throw new TypeError("Invalid node gate boundary");
        // A queued gate still needs its ACK after cancellation, but cannot dispatch another effect.
        if (!intent) {
          executions.cost(id, current, operation.costUsd);
          executions.emit(id, { ...current, payload: { kind: "dispatched", target: "validation-gate" } });
        }
        checkpoint(); report(id); return receipt;
      case "repair": {
        if (node.type !== "agent" || executions.rows(current).some(row => row.payload.kind === "drain-ack")) throw new TypeError("Invalid node repair boundary");
        if (executions.finish(id, current, operation.result, false, operation.executed) && !operation.result.ok && !operation.result.skipped) recordFeedbackFailure(id, operation.result.error ?? "Node validation failed");
        const next = executions.begin(id, node);
        if (!next) throw new TypeError("Execution budget exhausted");
        // Preserve durable cancellation across the identity change required by the repair ACK.
        if (intent === "skip" || intent === "retry" || intent === "lifecycle" || intent === "cancel") executions.cancel(id, intent);
        checkpoint(); report(id);
        return admissionReceipt({ ...receipt, correlation: next, executionSequence: executions.index.consumed(next) });
      }
      case "cancel":
        if (intent !== operation.disposition) throw new TypeError("Node cancellation disposition was not persisted");
        return receipt;
      case "settle": {
        const expected = intent === "retry" ? "retry" : intent === "lifecycle" ? "retain" : "complete";
        // A normal settlement may already be in flight when cancellation commits. Durable intent wins.
        if (operation.cancelled ? operation.projection !== expected || intent === undefined : operation.projection !== "complete") throw new TypeError("Invalid node settlement disposition");
        const ordinary = executions.finish(id, current, operation.result, intent !== undefined, operation.executed);
        if (ordinary && !operation.result.ok && !operation.result.skipped) recordFeedbackFailure(id, operation.result.error ?? "Node validation failed");
        if (projection.nodes.get(id)?.status !== "running") { report(id); return receipt; }
        switch (expected) {
          case "complete": complete(id, intent !== undefined ? { ok: false, skipped: true } : { ok: operation.result.ok, error: operation.result.error, skipped: operation.result.skipped, output: parseOutput(node, operation.result) }); break;
          case "retry": transition({ kind: "retry", id }); break;
          case "retain": break;
          default: { const exhaustive: never = expected; throw new TypeError(`Unknown node projection: ${exhaustive}`); }
        }
        report(id); return receipt;
      }
      default: { const exhaustive: never = operation; throw new TypeError(`Unknown node operation: ${exhaustive}`); }
    }
  };
  const acceptNested = (request: ChildCheckpointRequest): Readonly<Record<string, number>> => {
    const { id, frame, sequence } = request;
    if (childInvocation(id) !== request.invocation || frame.state.runtime?.runId !== request.invocation || projection.nodes.get(id)?.status !== "running") throw new TypeError("Stale nested checkpoint identity");
    assertGraphDepth(frame.state, depth + 1);
    instances.state.nested ??= Object.create(null);
    const nested = instances.state.nested;
    if (!nested) throw new TypeError("Missing nested checkpoint owner");
    const prior = nested[id];
    const same = prior?.state.runtime?.runId === request.invocation;
    const previousSequence = same ? prior.state.runtime?.revision ?? 0 : 0;
    if (sequence === previousSequence) {
      if (!prior || !isDeepStrictEqual(prior.state, frame.state) || !isDeepStrictEqual(prior.graph, frame.graph) || !isDeepStrictEqual(prior.input, frame.input)) throw new TypeError("Conflicting nested checkpoint sequence");
      return prior.ordinals;
    }
    if (sequence !== previousSequence + 1) throw new TypeError("Reordered nested checkpoint sequence");
    validateGraphRestore(frame.state, frame.graph, frame.input);
    if (same) {
      const snapshot = (value: { graph: AgentGraph; state: SchedulerState; input?: unknown }) => ({ version: 2 as const, runId: request.invocation, graph: value.graph, state: value.state, input: value.input, savedAt: 0, waitingGate: "" });
      validateCheckpointTransition(snapshot(prior), snapshot(frame));
    }
    const ordinals = same ? { ...prior.ordinals } : Object.create(null);
    for (const row of nestedMaterializations(frame.graph, frame.state)) ordinals[row.key] ??= instances.reserveOrdinal();
    let previous = prior?.previous ?? [];
    if (prior && !same) { const { previous: _history, ...completed } = prior; previous = [...previous, completed]; }
    nested[id] = { graph: frame.graph, state: frame.state, input: frame.input, ordinals, ...(previous.length ? { previous } : {}) };
    checkpoint(); return ordinals;
  };
  const settleGraph = (id: string, result: RunGraphResult): void => {
      if (coordinatorCancellation === "lifecycle") return;
      const intent = disposition(id);
      if (intent === "retry") transition({ kind: "retry", id });
      else complete(id, intent === "skip" ? { ok: false, skipped: true } : { ok: result.status === "completed", output: result.outputs, error: result.status === "completed" ? undefined : `subgraph ${result.status}` });
      report(id);
  };
  return {
    options, durable, frames, publications, projection, instances, executions, plan, running, checkpoint, control, controlCandidate, disposition, acceptNested, childInvocation,
    nodeRequest, coordinatorRequest, coordinatorIdentity, collectionView, feedbackView,
    nodeResolved: (event: Extract<NodeParentEvent, { type: "NODE.RESOLVED" }>) => {
      if (executions.accepts(event.id, event.correlation)) publish(() => options.onNodeResolved?.(displayId(event.id), event.info, event.correlation));
    },
    publishInitial: initializePublications,
    prepareRecovery: () => executions.prepareRecovery(options.host, options.reclaimedDeadWriter === true),
    reconcile: (commit: () => void) => {
      commit(); const recovery = executions.recoveryProposal(); applyRecovery(projection.state, recovery); for (const id of recovery.restarts) { restoringStarts.delete(id); restoringNested.delete(id); }
      for (const [id, run] of Object.entries(options.restore?.nodes ?? {})) if (run.status === "running" && ["expand", "fanout", "bounded_feedback"].includes(nodeDefs.get(id)?.type ?? "")) startNode(id);
      if (protocolRuntime.cancelled) cancelFeedback(); checkpoint();
    },
    cancel: (reason: unknown) => {
      const lifecycle = ["reload", "switch", "shutdown"].includes(String(reason));
      coordinatorCancellation = lifecycle ? "lifecycle" : "cancel";
      executions.cancelAll(lifecycle ? "lifecycle" : "cancel");
      if (!lifecycle) { protocolRuntime.cancelled = true; cancelFeedback(); } checkpoint();
    },
    result: (aborted: boolean): RunGraphResult => ({ status: aborted ? "aborted" : projection.runStatus(new Set(Object.values(feedbackStates).flatMap(state => [...state.iterations, ...(state.active ? [state.active] : [])].map(row => row.evaluator)))) === "failed" ? "failed" : "completed", outputs: aborted && !durable ? {} : projection.resolveOutputs(), nodes: Object.fromEntries([...projection.nodes].map(([id, run]) => [id, { ...run }])), ...(graph.version === 2 ? { feedback: Object.fromEntries(Object.entries(feedbackStates).flatMap(([id, state]) => state.terminal ? [[id, state.terminal]] : [])) } : {}) }),
  };
}
export type GraphDomain = ReturnType<typeof createGraphDomain>;

function assertGraphDepth(state: SchedulerState | undefined, depth: number): void {
  if (depth > 32) throw new TypeError("Graph nesting exceeds depth 32");
  for (const nested of Object.values(state?.runtime?.nested ?? {})) {
    for (const child of [...nested.previous ?? [], nested]) assertGraphDepth(child.state, depth + 1);
  }
}
