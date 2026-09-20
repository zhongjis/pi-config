import { type ActorRefFrom, type AnyStateMachine, assign, enqueueActions, fromPromise, sendParent, sendTo, setup, stateIn } from "xstate";
import { CoordinatorRequestJournal, captureCoordinatorRequest } from "./coordinator-protocol.js";
import { expandLogic } from "./expand-actor.js";
import { fanoutLogic } from "./fanout-actor.js";
import { feedbackLogic } from "./feedback-actor.js";
import { createGraphDomain, type GraphDomain } from "./graph-domain.js";
import { matchesExecution } from "./graph-execution.js";
import type { ChildCheckpointRequest, ChildGraphDrained, GraphActorInput, GraphAdmission, GraphEvent, GraphReply } from "./graph-protocol.js";
import { agentNodeLogic, humanGateNodeLogic } from "./node-lifecycle.js";
import { captureRequest, type NodeRequest, NodeRequestJournal } from "./node-protocol.js";
import type { GraphControl, RunGraphResult } from "./run-graph.js";
import { subgraphLogic } from "./subgraph-actor.js";
import { MAX_NODES } from "./validate.js";

interface GraphContext {
  readonly source: GraphActorInput;
  readonly children: () => readonly string[];
  domain?: GraphDomain;
  failure?: { readonly error: unknown };
  cancellation?: { readonly reason: unknown };
  controlBusy: boolean;
  controlAck?: { readonly token: symbol; readonly accepted: boolean };
  admissions: GraphAdmission[];
  readonly journals: Map<string, NodeRequestJournal>;
  readonly coordinators: Map<string, CoordinatorRequestJournal>;
  inbox: Extract<GraphEvent, { type: "NODE.REQUEST" | "COORD.REQUEST" | "CONTROL" }>[];
  outcomes: Extract<GraphEvent, { type: "NODE.REQUEST" }>[];
  releases: string[];
  cancels: string[];
  replies: GraphReply[];
  generation: number;
  flushScheduled: boolean;
  flushReady: boolean;
}
const domainOf = (context: GraphContext): GraphDomain => {
  if (!context.domain) throw new TypeError("Graph domain is not initialized");
  return context.domain;
};
// no-excuse-ok: catch — root boundary latches the exact first infrastructure error until physical drain.
function transaction(context: GraphContext, apply: (domain: GraphDomain) => void): void {
  if (context.failure) return;
  context.controlBusy = true;
  try { apply(domainOf(context)); }
  catch (error) { context.failure ??= { error }; } // no-excuse-ok: catch
  finally { context.controlBusy = false; }
}
function cancellationEvent(context: GraphContext, id: string) {
  const coordinator = context.coordinators.get(id);
  if (coordinator?.receipt.kind === "graph") return { type: "COORD.CANCEL" as const, receipt: coordinator.receipt,
    disposition: domainOf(context).disposition(id) ?? (["reload", "switch", "shutdown"].includes(String(context.cancellation?.reason)) ? "lifecycle" : "cancel") };
  if (coordinator) return { type: "COORD.CANCEL" as const, receipt: coordinator.receipt,
    disposition: ["reload", "switch", "shutdown"].includes(String(context.cancellation?.reason)) ? "lifecycle" as const : "cancel" as const };
  if (!context.journals.has(id)) return { type: "CANCEL" as const, reason: context.cancellation?.reason };
  const disposition = domainOf(context).disposition(id);
  switch (disposition) {
    case "skip": case "retry": case "lifecycle": case "cancel": return { type: "CANCEL" as const, disposition, reason: context.cancellation?.reason };
    // A settled execution has no cancellation intent; it only needs its release handshake.
    case undefined: return { type: "WAKE" as const };
    default: throw new TypeError("Invalid durable cancellation disposition");
  }
}
function prepareNodeReply(context: GraphContext, request: NodeRequest): void {
  const journal = context.journals.get(request.id);
  if (!journal) throw new TypeError("Missing node request journal");
  const receipt = domainOf(context).nodeRequest(request, journal.receipt);
  const ack = { ...request, type: "NODE.ACK" as const, receipt };
  journal.prepare(ack);
  context.replies.push({ id: request.id, event: ack });
}
const recovery = fromPromise<() => void, GraphDomain>(({ input }) => input.prepareRecovery());
const persist = fromPromise<void, GraphContext>(async ({ input: context }) => {
  await Promise.resolve();
  if (context.failure) return;
  const domain = domainOf(context); const frame = domain.frames[0];
  if (!domain.durable) return;
  context.controlBusy = true;
  try {
    const committed: unknown = domain.options.onCheckpoint?.(frame.state, frame.graph);
    if (committed !== null && (typeof committed === "object" || typeof committed === "function") && "then" in committed) throw new TypeError("Checkpoint writer must be synchronous");
  } finally { context.controlBusy = false; }
});
const publish = fromPromise<void, readonly (() => void)[]>(async ({ input }) => {
  await Promise.resolve();
  for (const callback of input) callback();
});
function resultOf(context: GraphContext): RunGraphResult {
  return context.domain?.result(!!context.cancellation) ?? { status: "failed", outputs: {}, nodes: {} };
}

/** Root lifecycle authority. Panda checkpoints, not XState snapshots, remain durable. */
// allow: SIZE_OK — the root machine keeps admission, persistence, cancellation and physical drain in one hierarchy.
export const graphLogic = setup({
  types: { context: {} as GraphContext, input: {} as GraphActorInput, events: {} as GraphEvent, output: {} as RunGraphResult },
  actors: { agent: agentNodeLogic, human: humanGateNodeLogic, expand: expandLogic, fanout: fanoutLogic, feedback: feedbackLogic, recovery, persist, publish, get subgraph(): AnyStateMachine { return subgraphLogic; } },
  guards: {
    failed: ({ context }) => context.failure !== undefined,
    cancelled: ({ context }) => context.cancellation !== undefined,
    hasFrames: ({ context }) => !!context.domain?.frames.length,
    hasPublications: ({ context }) => !!context.domain?.publications.length,
    hasRequests: ({ context }) => context.inbox.length > 0,
    canFlush: ({ context }) => context.flushReady && context.outcomes.length > 0,
    hasAdmissions: ({ context }) => context.admissions.length > 0,
    hasAdmissionsToDrain: ({ context }) => !context.failure && !context.domain?.frames.length && context.admissions.some(admission => !context.cancellation && context.cancels.includes(admission.id)),
    done: ({ context }) => domainOf(context).projection.isDone() && !context.children().some(id => id.startsWith("node:")),
    paused: stateIn({ active: { admission: "paused" } }),
    nested: ({ context }) => context.source.parent !== undefined,
    drained: ({ context }) => !context.children().some(id => id.startsWith("node:")),
  },
  actions: {
    initialize: assign(({ context, self }) => {
      // no-excuse-ok: catch — initialization failures use the same delayed root error boundary.
      try {
        context.domain = createGraphDomain(context.source, () => context.children().filter(id => id.startsWith("node:")).map(id => id.slice(5)));
        let sending = false;
        const control = (kind: "skip" | "retry", index: number): boolean => {
          const snapshot = self.getSnapshot();
          if (sending || snapshot.context.controlBusy || snapshot.status !== "active" || snapshot.hasTag("initializing") || snapshot.hasTag("draining") || snapshot.context.failure || snapshot.context.cancellation) return false;
          const token = Symbol(kind);
          sending = true;
          try { self.send({ type: "CONTROL", token, index, kind }); }
          finally { sending = false; }
          const ack = self.getSnapshot().context.controlAck;
          return ack?.token === token && ack.accepted;
        };
        const surface: GraphControl = {
          pause: () => self.send({ type: "PAUSE" }), resume: () => self.send({ type: "RESUME" }),
          isPaused: () => self.getSnapshot().matches({ active: { admission: "paused" } }),
          skip: index => control("skip", index), retry: index => control("retry", index),
        };
        context.domain.publications.push(() => context.source.options.onControl?.(surface));
      } catch (error) { context.failure ??= { error }; } // no-excuse-ok: catch
      return { domain: context.domain, failure: context.failure };
    }),
    plan: ({ context }) => transaction(context, domain => {
      context.admissions = domain.plan();
      for (const admission of context.admissions) {
        switch (admission.kind) {
          case "graph": case "feedback": case "fanout": case "expand": context.coordinators.set(admission.id, new CoordinatorRequestJournal(admission.input.receipt)); break;
          case "agent": case "human": context.journals.set(admission.id, new NodeRequestJournal(admission.input.receipt)); break;
          default: { const exhaustive: never = admission; throw new TypeError(`Unknown admission: ${exhaustive}`); }
        }
      }
    }),
    captureFailure: ({ context, event }) => { if (event.type === "FAIL") context.failure ??= { error: event.error }; },
    latchCancel: ({ context, event }) => { if (event.type === "CANCEL") context.cancellation ??= { reason: event.reason }; },
    control: ({ context, event }) => {
      if (event.type !== "CONTROL") return;
      context.controlAck = { token: event.token, accepted: false };
      if (context.failure || context.cancellation || context.controlBusy) return;
      const id = context.domain?.controlCandidate(event.index, event.kind);
      if (id === undefined) return;
      const queued = context.inbox.find(request => request.type === "CONTROL" && request.index === event.index);
      if (queued && (queued.type !== "CONTROL" || queued.kind !== event.kind)) return;
      context.controlAck = { token: event.token, accepted: true };
      if (!queued) context.inbox.push(event);
    },
    enqueueNodeRequest: enqueueActions(({ context, event, enqueue, self }): void => {
      if (event.type !== "NODE.REQUEST") return;
      transaction(context, domain => {
        const journal = context.journals.get(event.id);
        if (!journal) throw new TypeError("Missing node request journal");
        const delivery = journal.receive(event, domain.executions.current(event.id) ?? journal.receipt.correlation);
        switch (delivery.kind) {
          case "pending": return;
          case "replay": context.replies.push({ id: event.id, event: delivery.ack }); return;
          case "apply": break;
          default: { const exhaustive: never = delivery; throw new TypeError(`Unknown node delivery: ${exhaustive}`); }
        }
        if (context.inbox.length + context.outcomes.length >= MAX_NODES * 2) throw new TypeError("Graph transaction queue exceeded its bound");
        const request = captureRequest(event);
        if (request.operation.kind !== "settle") { context.inbox.push(request); return; }
        context.outcomes.push(request);
        if (!context.flushScheduled) {
          context.flushScheduled = true;
          enqueue.sendTo(self, { type: "FLUSH", generation: context.generation }, { delay: 0 });
        }
      });
    }),
    enqueueCoordinatorRequest: ({ context, event }) => {
      if (event.type !== "COORD.REQUEST") return;
      transaction(context, domain => {
        const journal = context.coordinators.get(event.receipt.id);
        if (!journal) throw new TypeError("Missing coordinator request journal");
        const delivery = journal.receive(event, domain.coordinatorIdentity(event.receipt.id, journal.receipt.incarnation));
        switch (delivery.kind) {
          case "pending": return;
          case "replay": context.replies.push({ id: event.receipt.id, event: delivery.ack }); return;
          case "apply": break;
          default: { const exhaustive: never = delivery; throw new TypeError(`Unknown coordinator delivery: ${exhaustive}`); }
        }
        if (context.inbox.length >= MAX_NODES * 2) throw new TypeError("Graph transaction queue exceeded its bound");
        context.inbox.push(captureCoordinatorRequest(event));
      });
    },
    request: ({ context }) => transaction(context, domain => {
      const request = context.inbox.shift(); if (!request) return;
      switch (request.type) {
        case "NODE.REQUEST": prepareNodeReply(context, request); break;
        case "COORD.REQUEST": {
          const journal = context.coordinators.get(request.receipt.id);
          if (!journal) throw new TypeError("Missing coordinator request journal");
          const ordinals = domain.coordinatorRequest(request);
          const ack = { ...request, type: "COORD.ACK" as const, ...(ordinals ? { ordinals: Object.freeze({ ...ordinals }) } : {}) };
          journal.prepare(ack); context.replies.push({ id: request.receipt.id, event: ack }); break;
        }
        case "CONTROL": { const id = domain.control(request.index, request.kind); if (id !== undefined) context.cancels.push(id); break; }
      }
    }),
    flush: ({ context, event }) => { if (event.type === "FLUSH" && event.generation === context.generation) context.flushReady = true; },
    settle: ({ context }) => transaction(context, domain => {
      const outcomes = context.outcomes.splice(0);
      for (const outcome of outcomes) prepareNodeReply(context, outcome);
      context.flushReady = false; context.flushScheduled = false; context.generation++;
      if (outcomes.length) domain.checkpoint();
    }),
    committed: enqueueActions(({ context, enqueue, self }): void => {
      if (context.failure) return;
      transaction(context, () => {
        for (const reply of context.replies) if (reply.event.type === "NODE.ACK") {
          const journal = context.journals.get(reply.id);
          if (!journal) throw new TypeError("Missing node acknowledgment journal");
          journal.commit(reply.event);
        } else if (reply.event.type === "COORD.ACK") {
          const journal = context.coordinators.get(reply.id);
          if (!journal) throw new TypeError("Missing coordinator acknowledgment journal");
          journal.commit(reply.event);
        }
      });
      if (context.failure) return;
      enqueue.sendTo(self, { type: "WAKE" }, { delay: 0 });
      for (const id of context.cancels.splice(0)) {
        if (context.children().includes(`node:${id}`)) enqueue.sendTo(`node:${id}`, cancellationEvent(context, id));
        else if (context.admissions.some(admission => admission.id === id)) context.cancels.push(id);
      }
      for (const reply of context.replies.splice(0)) {
        if (reply.event.type === "NODE.ACK" && context.cancellation && reply.event.operation.kind !== "settle") {
          if (!domainOf(context).disposition(reply.id)) { context.replies.push(reply); continue; }
          enqueue.sendTo(`node:${reply.id}`, cancellationEvent(context, reply.id));
        }
        enqueue.sendTo(`node:${reply.id}`, reply.event);
      }
      for (const [id, journal] of context.coordinators) {
        if (journal.receipt.kind === "bounded_feedback" && context.children().includes(`node:${id}`)) enqueue.sendTo(`node:${id}`, { type: "COORD.FEEDBACK_VIEW", receipt: journal.receipt, view: domainOf(context).feedbackView(id) });
        if (journal.receipt.kind === "fanout" && context.children().includes(`node:${id}`)) {
          enqueue.sendTo(`node:${id}`, { type: "COORD.VIEW", receipt: journal.receipt, view: domainOf(context).collectionView(id) });
        }
      }
    }),
    dispatch: enqueueActions(({ context, enqueue }): void => {
      for (const admission of context.admissions.splice(0)) {
        switch (admission.kind) {
          case "agent": enqueue.spawnChild("agent", { id: `node:${admission.id}`, input: admission.input }); break;
          case "human": enqueue.spawnChild("human", { id: `node:${admission.id}`, input: admission.input }); break;
          case "expand": enqueue.spawnChild("expand", { id: `node:${admission.id}`, input: admission.input }); break;
          case "feedback": enqueue.spawnChild("feedback", { id: `node:${admission.id}`, input: admission.input }); break;
          case "fanout": enqueue.spawnChild("fanout", { id: `node:${admission.id}`, input: admission.input }); break;
          case "graph": enqueue.spawnChild("subgraph", { id: `node:${admission.id}`, input: admission.input }); break;
        }
        if (context.failure) enqueue.sendTo(`node:${admission.id}`, { type: "FAIL", error: context.failure.error });
        else {
          if (context.cancels.includes(admission.id) || context.cancellation) enqueue.sendTo(`node:${admission.id}`, cancellationEvent(context, admission.id));
          switch (admission.kind) {
            case "graph": case "feedback": case "fanout": case "expand":
              enqueue.sendTo(`node:${admission.id}`, { type: "COORD.ADMITTED", receipt: admission.input.receipt });
              // Later admissions in the same committed wave may have exhausted a restored leaf.
              if (admission.kind === "feedback") enqueue.sendTo(`node:${admission.id}`, { type: "COORD.FEEDBACK_VIEW", receipt: admission.input.receipt, view: domainOf(context).feedbackView(admission.id) });
              if (admission.kind === "fanout") enqueue.sendTo(`node:${admission.id}`, { type: "COORD.VIEW", receipt: admission.input.receipt, view: domainOf(context).collectionView(admission.id) });
              break;
            case "agent": case "human": enqueue.sendTo(`node:${admission.id}`, { type: "NODE.ADMITTED", receipt: admission.input.receipt }); break;
            default: { const exhaustive: never = admission; throw new TypeError(`Unknown admission: ${exhaustive}`); }
          }
        }
        context.cancels = context.cancels.filter(id => id !== admission.id);
      }
    }),
    cancel: ({ context }) => transaction(context, domain => domain.cancel(context.cancellation?.reason)),
    abortChildren: enqueueActions(({ context, enqueue, self }): void => {
      for (const [id, actor] of Object.entries(self.getSnapshot().children)) if (id.startsWith("node:") && actor && actor.getSnapshot().status === "active") {
        enqueue.sendTo(actor, context.failure ? { type: "FAIL", error: context.failure.error } : cancellationEvent(context, id.slice(5)));
      }
    }),
    discardDrained: enqueueActions(({ context, enqueue, self }): void => {
      enqueue.sendTo(self, { type: "WAKE" }, { delay: 0 });
      context.outcomes.splice(0);
      for (const id of new Set(context.releases.splice(0))) { enqueue.stopChild(`node:${id}`); context.journals.delete(id); context.coordinators.delete(id); }
      context.flushReady = false; context.flushScheduled = false; context.generation++;
    }),
    coordinatorRelease: enqueueActions(({ context, event, enqueue, self }): void => {
      if (event.type !== "COORD.RELEASE_READY" && event.type !== "COORD.RELEASED") return;
      const id = event.receipt.id; const journal = context.coordinators.get(id);
      if (!journal?.matches(event) || !journal.committed(event.requestSequence) || journal.receipt.kind === "graph" && journal.committed(event.requestSequence)?.operation.kind !== "nested-settlement") {
        context.failure ??= { error: new TypeError("Invalid coordinator release evidence") }; return;
      }
      if (event.type === "COORD.RELEASE_READY") enqueue.sendTo(`node:${id}`, { type: "COORD.RELEASE", receipt: journal.receipt });
      else {
        enqueue.stopChild(`node:${id}`); context.coordinators.delete(id);
        enqueue.sendTo(self, { type: "WAKE" }, { delay: 0 });
      }
    }),
    coordinatorDrained: ({ context, event }) => {
      if (event.type !== "COORD.DRAINED") return;
      const id = event.receipt.id;
      if (!context.coordinators.get(id)?.matches(event)) { context.failure ??= { error: new TypeError("Invalid coordinator drain identity") }; return; }
      context.failure ??= event.failure;
      if (!context.releases.includes(id)) context.releases.push(id);
    },
    nodeResolved: ({ context, event }) => {
      if (event.type !== "NODE.RESOLVED") return;
      const journal = context.journals.get(event.id);
      if (journal?.matchesIncarnation(event) && matchesExecution(journal.receipt.correlation, event.correlation)) transaction(context, domain => domain.nodeResolved(event));
    },
    nodeReleaseReady: enqueueActions(({ context, event, enqueue }): void => {
      if (event.type !== "NODE.RELEASE_READY") return;
      transaction(context, () => {
        const journal = context.journals.get(event.id);
        if (!journal?.matchesIncarnation(event) || !matchesExecution(journal.receipt.correlation, event.correlation) || !journal.committedSettlement(event.requestSequence)) throw new TypeError("Invalid node release evidence");
        enqueue.sendTo(`node:${event.id}`, { type: "NODE.RELEASE", receipt: journal.receipt });
      });
    }),
    nodeReleased: enqueueActions(({ context, event, enqueue, self }): void => {
      if (event.type !== "NODE.RELEASED") return;
      const journal = context.journals.get(event.id);
      if (!journal?.matchesIncarnation(event)) return;
      const settlement = journal.committedSettlement(event.requestSequence);
      if (!settlement || !matchesExecution(settlement.receipt.correlation, event.correlation)) { context.failure ??= { error: new TypeError("Invalid node release completion") }; return; }
      enqueue.stopChild(`node:${event.id}`);
      context.journals.delete(event.id);
      enqueue.sendTo(self, { type: "WAKE" }, { delay: 0 });
    }),
    nodeDrained: ({ context, event }) => {
      if (event.type !== "NODE.DRAINED") return;
      const journal = context.journals.get(event.id);
      if (!journal?.matchesIncarnation(event)) return;
      const current = context.domain?.executions.current(event.id);
      if (!context.failure && (!current || !matchesExecution(current, event.correlation))) return;
      context.failure ??= event.failure;
      if (!context.releases.includes(event.id)) context.releases.push(event.id);
    },
    checkpoint: ({ context }) => transaction(context, domain => domain.checkpoint()),
    requestCheckpoint: sendParent(({ context }): ChildCheckpointRequest => {
      const frame = domainOf(context).frames[0]; const parent = context.source.parent;
      if (!frame || !parent || !frame.state.runtime) throw new TypeError("Missing nested persistence request");
      return { type: "CHECKPOINT.REQUEST", ...parent, sequence: frame.state.runtime.revision, frame: { ...frame, publications: [...domainOf(context).publications] } };
    }),
    advanceCheckpoint: ({ context }) => { domainOf(context).frames.shift(); },
    notifyParent: sendParent(({ context }): ChildGraphDrained => {
      const parent = context.source.parent; if (!parent) throw new TypeError("Missing graph parent");
      return { type: "GRAPH.DRAINED", ...parent, result: resultOf(context), ...(context.failure ? { failure: context.failure } : {}) };
    }),
  },
}).createMachine({
  id: "graph",
  context: ({ input, self }) => ({ source: input, controlBusy: false, children: () => Object.keys(self.getSnapshot()?.children ?? {}), admissions: [], journals: new Map(), coordinators: new Map(), inbox: [], outcomes: [], releases: [], cancels: [], replies: [], generation: 0, flushScheduled: false, flushReady: false }),
  initial: "active",
  output: ({ context }) => resultOf(context),
  states: {
    active: {
      type: "parallel",
      on: {
        CANCEL: { actions: "latchCancel" }, FAIL: { actions: "captureFailure" }, CONTROL: { actions: "control" },
        "COORD.REQUEST": { actions: "enqueueCoordinatorRequest" }, "COORD.RELEASE_READY": { actions: "coordinatorRelease" },
        "COORD.RELEASED": { actions: "coordinatorRelease" }, "COORD.DRAINED": { actions: "coordinatorDrained" },
        "NODE.REQUEST": { actions: "enqueueNodeRequest" }, "NODE.RESOLVED": { actions: "nodeResolved" },
        "NODE.RELEASE_READY": { actions: "nodeReleaseReady" }, "NODE.RELEASED": { actions: "nodeReleased" }, "NODE.DRAINED": { actions: "nodeDrained" },
        FLUSH: { actions: "flush" }, WAKE: {},
      },
      states: {
        admission: { initial: "running", states: { running: { on: { PAUSE: "paused" } }, paused: { on: { RESUME: "running" } } } },
        lifecycle: {
          initial: "initializing",
          states: {
            initializing: {
              tags: "initializing", initial: "validate",
              states: {
                validate: { entry: sendTo(({ self }) => self, { type: "START" }), on: { START: { actions: "initialize", target: "checked" } } },
                checked: { always: [{ guard: "failed", target: "#graphDrain" }, { target: "reconcile" }] },
                reconcile: { invoke: { src: "recovery", input: ({ context }) => domainOf(context),
                  onDone: { target: "checkpoint", actions: ({ context, event }) => transaction(context, domain => { domain.reconcile(event.output); if (domain.instances.state.cancelled) context.cancellation ??= { reason: "restored cancellation" }; domain.publishInitial(); }) },
                  onError: { target: "#graphDrain", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } },
                } },
                checkpoint: { always: "#graphPersist" },
              },
            },
            route: { id: "graphRoute", always: [
              { guard: "hasAdmissionsToDrain", target: "dispatch" },
              { guard: "failed", target: "draining" },
              { guard: "cancelled", target: "cancelling" },
              { guard: "hasFrames", target: "persisting" },
              { guard: ({ context }) => !!(context.replies.length || context.cancels.length || context.releases.length), target: "replying" },
              { guard: "hasPublications", target: "publishing" },
              { guard: "hasRequests", target: "transaction" },
              { guard: "canFlush", target: "settling" },
              { guard: "hasAdmissions", target: "dispatch" },
              { guard: "paused", target: "waiting" },
              { guard: "done", target: "checkpointingTerminal" },
              { target: "planning" },
            ] },
            planning: { always: [{ guard: "paused", target: "waiting" }, { target: "admitting" }] },
            admitting: { entry: "plan", always: [
              { guard: "failed", target: "draining" }, { guard: "hasFrames", target: "persisting" },
              { guard: "hasPublications", target: "publishing" }, { guard: "hasAdmissions", target: "dispatch" },
              { guard: "done", target: "checkpointingTerminal" }, { target: "waiting" },
            ] },
            // Publish the spawned-child snapshot before route inspects supervision/drain state.
            dispatch: { id: "graphDispatch", entry: ["dispatch", sendTo(({ self }) => self, { type: "WAKE" })], on: { WAKE: "route" } },
            waiting: { always: [
              { guard: "failed", target: "draining" }, { guard: "cancelled", target: "cancelling" },
              { guard: "hasFrames", target: "persisting" }, { guard: "hasPublications", target: "publishing" },
              { guard: ({ context }) => context.replies.length > 0, target: "replying" },
              { guard: "hasRequests", target: "transaction" }, { guard: "canFlush", target: "settling" },
            ], on: { RESUME: { target: "planning" }, WAKE: { target: "route" } } },
            replying: { entry: "committed", always: "route" },
            transaction: { entry: "request", always: "route" },
            settling: { entry: "settle", always: "route" },
            persisting: {
              id: "graphPersist", tags: "persisting", initial: "select",
              states: {
                select: { always: [{ guard: "failed", target: "#graphDrain" }, { guard: ({ context }) => !context.domain?.frames.length, target: "#graphPublished", actions: "committed" }, { guard: "nested", target: "request" }, { target: "writing" }] },
                request: { entry: "requestCheckpoint", always: { guard: "failed", target: "#graphDrain" }, on: { "CHECKPOINT.ACK": { guard: ({ context, event }) => domainOf(context).frames[0]?.state.runtime?.revision === event.sequence, target: "select", actions: "advanceCheckpoint" } } },
                writing: { invoke: { src: "persist", input: ({ context }) => context,
                  onDone: { target: "select", actions: "advanceCheckpoint" }, onError: { target: "#graphDrain", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } },
                } },
              },
            },
            publishing: { id: "graphPublished", invoke: { src: "publish", input: ({ context }) => domainOf(context).publications.splice(0),
              onDone: "route", onError: { target: "route", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } },
            } },
            cancelling: { entry: "cancel", always: [{ guard: "failed", target: "draining" }, { target: "persistingCancel" }] },
            persistingCancel: {
              tags: "persisting", initial: "select", states: {
                select: { always: [{ guard: "failed", target: "#graphDrain" }, { guard: ({ context }) => !context.domain?.frames.length && context.admissions.length > 0, target: "#graphCancelDispatch", actions: "committed" }, { guard: ({ context }) => !context.domain?.frames.length, target: "#graphDrain", actions: "committed" }, { guard: "nested", target: "request" }, { target: "writing" }] },
                request: { entry: "requestCheckpoint", always: { guard: "failed", target: "#graphDrain" }, on: { "CHECKPOINT.ACK": { guard: ({ context, event }) => domainOf(context).frames[0]?.state.runtime?.revision === event.sequence, target: "select", actions: "advanceCheckpoint" } } },
                writing: { invoke: { src: "persist", input: ({ context }) => context, onDone: { target: "select", actions: "advanceCheckpoint" }, onError: { target: "#graphDrain", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } } } },
              },
            },
            dispatchingCancel: { id: "graphCancelDispatch", tags: "draining", entry: ["dispatch", sendTo(({ self }) => self, { type: "WAKE" })], on: { WAKE: "draining" } },
            draining: {
              id: "graphDrain", tags: "draining", entry: "abortChildren", always: "drainWaiting",
            },
            drainWaiting: {
              id: "graphDrainWait", tags: "draining",
              always: [
                { guard: ({ context }) => !!context.failure && (context.outcomes.length > 0 || context.releases.length > 0), actions: "discardDrained" },
                { guard: ({ context }) => !context.failure && context.flushReady && context.outcomes.length > 0, target: "settlingDrain" },
                { guard: ({ context }) => !context.failure && context.replies.length > 0, target: "persistingDrain" },
                { guard: "drained", target: "checkpointingTerminal" },
                { guard: ({ context }) => !context.failure && context.inbox.length > 0, target: "drainRequest" },
              ],
            },
            drainRequest: { entry: "request", always: [{ guard: "failed", target: "draining" }, { target: "persistingDrain" }] },
            settlingDrain: { entry: "settle", always: [{ guard: "failed", target: "draining" }, { target: "persistingDrain" }] },
            persistingDrain: {
              tags: "persisting", initial: "select", states: {
                select: { always: [{ guard: "failed", target: "#graphDrain" }, { guard: ({ context }) => !context.domain?.frames.length, target: "#graphDrainWait", actions: "committed" }, { guard: "nested", target: "request" }, { target: "writing" }] },
                request: { entry: "requestCheckpoint", always: { guard: "failed", target: "#graphDrain" }, on: { "CHECKPOINT.ACK": { guard: ({ context, event }) => domainOf(context).frames[0]?.state.runtime?.revision === event.sequence, target: "select", actions: "advanceCheckpoint" } } },
                writing: { invoke: { src: "persist", input: ({ context }) => context, onDone: { target: "select", actions: "advanceCheckpoint" }, onError: { target: "#graphDrain", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } } } },
              },
            },
            checkpointingTerminal: {
              entry: "checkpoint", tags: "persisting", initial: "select", states: {
                select: { always: [{ guard: "failed", target: "#graphFinished" }, { guard: ({ context }) => !context.domain?.frames.length, target: "#graphFinished" }, { guard: "nested", target: "request" }, { target: "writing" }] },
                request: { entry: "requestCheckpoint", always: { guard: "failed", target: "#graphDrain" }, on: { "CHECKPOINT.ACK": { guard: ({ context, event }) => domainOf(context).frames[0]?.state.runtime?.revision === event.sequence, target: "select", actions: "advanceCheckpoint" } } },
                writing: { invoke: { src: "persist", input: ({ context }) => context, onDone: { target: "select", actions: "advanceCheckpoint" }, onError: { target: "#graphFinished", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } } } },
              },
            },
            finished: { id: "graphFinished", always: [{ guard: "nested", target: "notifying" }, { guard: "failed", target: "#graph.infrastructureFailure" }, { target: "#graph.terminal" }] },
            notifying: { entry: "notifyParent" },
          },
        },
      },
    },
    terminal: { type: "final" },
    infrastructureFailure: { entry: ({ context }) => { throw context.failure?.error; } },
  },
});
export type GraphActor = ActorRefFrom<typeof graphLogic>;
