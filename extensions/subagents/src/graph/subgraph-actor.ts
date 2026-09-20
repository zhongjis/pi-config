import { isDeepStrictEqual } from "node:util";
import { type AnyStateMachine, enqueueActions, sendParent, setup } from "xstate";
import { type CoordinatorAck, type CoordinatorChildEvent, type CoordinatorParentEvent, type CoordinatorReceipt, type CoordinatorRequest, captureCoordinatorRequest, coordinatorReceipt } from "./coordinator-protocol.js";
import { graphLogic } from "./graph-actor.js";
import type { ChildCheckpointRequest, ChildGraphDrained, GraphActorInput } from "./graph-protocol.js";

export interface SubgraphInput {
  readonly receipt: CoordinatorReceipt;
  readonly child: GraphActorInput;
}
type SubgraphEvent = CoordinatorChildEvent | ChildCheckpointRequest | ChildGraphDrained |
  { readonly type: "COORD.CANCEL"; readonly receipt: CoordinatorReceipt; readonly disposition: "skip" | "retry" };
interface SubgraphContext {
  readonly input: SubgraphInput;
  readonly receipt: CoordinatorReceipt;
  request?: CoordinatorRequest;
  ack?: CoordinatorAck;
  cancellation?: "skip" | "retry" | "cancel" | "lifecycle";
  failure?: { readonly error: unknown };
  spawned: boolean;
  drained: boolean;
}
function envelope(context: SubgraphContext) { return { receipt: context.receipt, requestSequence: context.request?.requestSequence ?? 0 }; }
function matchesChild(context: SubgraphContext, event: ChildCheckpointRequest | ChildGraphDrained): boolean {
  return event.id === context.receipt.id && event.invocation === context.input.child.parent?.invocation;
}
function matchesAck(context: SubgraphContext, event: CoordinatorAck): boolean {
  const { ordinals, ...ack } = event;
  return isDeepStrictEqual(context.request, { ...ack, type: "COORD.REQUEST" }) &&
    (event.operation.kind !== "nested-checkpoint" || ordinals !== undefined) &&
    (!context.ack || isDeepStrictEqual(context.ack, event));
}
/** Explicit native ownership: cancellation never exits an invoke or substitutes for drain. */
export const subgraphLogic = setup({
  types: { input: {} as SubgraphInput, context: {} as SubgraphContext, events: {} as SubgraphEvent },
  actors: { get graph(): AnyStateMachine { return graphLogic; } },
  actions: {
    invalid: ({ context }) => { context.failure ??= { error: new TypeError("Invalid subgraph handoff, request, acknowledgment or release") }; },
    spawn: enqueueActions(({ context, enqueue }) => {
      context.spawned = true;
      enqueue.spawnChild("graph", { id: "graph", systemId: context.input.child.parent?.invocation, input: context.input.child });
      if (context.cancellation) enqueue.sendTo("graph", { type: "CANCEL", reason: context.cancellation === "lifecycle" ? "reload" : context.cancellation });
    }),
    checkpoint: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "CHECKPOINT.REQUEST") return;
      const prior = context.request;
      if (prior?.operation.kind === "nested-checkpoint" && prior.operation.request.sequence === event.sequence) {
        if (!isDeepStrictEqual(prior.operation.request, event)) { context.failure ??= { error: new TypeError("Conflicting nested checkpoint sequence") }; return; }
        if (context.ack) enqueue.sendTo("graph", { type: "CHECKPOINT.ACK", sequence: event.sequence, ordinals: context.ack.ordinals });
        return;
      }
      if (prior && !context.ack) { context.failure ??= { error: new TypeError("Nested checkpoint still pending") }; return; }
      context.request = captureCoordinatorRequest({ type: "COORD.REQUEST", receipt: context.receipt, requestSequence: (prior?.requestSequence ?? 0) + 1, operation: { kind: "nested-checkpoint", request: event } });
      context.ack = undefined;
      enqueue.sendParent(context.request);
    }),
    acknowledge: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "COORD.ACK") return;
      context.ack = event;
      if (event.operation.kind === "nested-checkpoint") enqueue.sendTo("graph", { type: "CHECKPOINT.ACK", sequence: event.operation.request.sequence, ordinals: event.ordinals });
    }),
    settle: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "GRAPH.DRAINED") return;
      context.drained = true;
      context.failure ??= event.failure;
      if (context.failure) return;
      if (!context.ack) { context.failure = { error: new TypeError("Subgraph drained before checkpoint acknowledgment") }; return; }
      context.request = captureCoordinatorRequest({ type: "COORD.REQUEST", receipt: context.receipt, requestSequence: (context.request?.requestSequence ?? 0) + 1, operation: { kind: "nested-settlement", result: event } });
      context.ack = undefined;
      enqueue.sendParent(context.request);
    }),
    cancel: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "COORD.CANCEL") return;
      context.cancellation ??= event.disposition;
      if (context.spawned && !context.drained) enqueue.sendTo("graph", { type: "CANCEL", reason: context.cancellation === "lifecycle" ? "reload" : context.cancellation });
    }),
    failChild: enqueueActions(({ context, enqueue }) => {
      if (context.spawned && !context.drained) enqueue.sendTo("graph", { type: "FAIL", error: context.failure?.error });
    }),
  },
}).createMachine({
  id: "subgraph", context: ({ input }) => ({ input, receipt: coordinatorReceipt(input.receipt), spawned: false, drained: false }), initial: "awaitingAdmission",
  on: {
    FAIL: { target: ".failing", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } },
    "COORD.CANCEL": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), actions: "cancel" },
      { target: ".failing", actions: "invalid" },
    ],
    "COORD.ADMITTED": { target: ".failing", actions: "invalid" },
    "COORD.ACK": { target: ".failing", actions: "invalid" },
    "COORD.RELEASE": { target: ".failing", actions: "invalid" },
    "CHECKPOINT.REQUEST": { target: ".failing", actions: "invalid" },
    "GRAPH.DRAINED": { target: ".failing", actions: "invalid" },
  },
  states: {
    awaitingAdmission: { on: { "COORD.ADMITTED": [
      { guard: ({ context, event }) => context.receipt.kind === "graph" && context.input.child.parent?.id === context.receipt.id && isDeepStrictEqual(context.receipt, event.receipt), target: "supervising" },
      { target: "failing", actions: "invalid" },
    ] } },
    supervising: {
      entry: "spawn", always: { guard: ({ context }) => !!context.failure, target: "failing" },
      on: {
        "CHECKPOINT.REQUEST": [
          { guard: ({ context, event }) => matchesChild(context, event), actions: "checkpoint" },
          { target: "failing", actions: "invalid" },
        ],
        "COORD.ACK": [
          { guard: ({ context, event }) => matchesAck(context, event), actions: "acknowledge" },
          { target: "failing", actions: "invalid" },
        ],
        "GRAPH.DRAINED": [
          { guard: ({ context, event }) => matchesChild(context, event), target: "waitingSettlement", actions: "settle" },
          { target: "failing", actions: "invalid" },
        ],
      },
    },
    waitingSettlement: {
      always: { guard: ({ context }) => !!context.failure, target: "failing" },
      on: { "COORD.ACK": [
        { guard: ({ context, event }) => matchesAck(context, event), target: "releaseReady", actions: "acknowledge" },
        { target: "failing", actions: "invalid" },
      ] },
    },
    releaseReady: {
      entry: sendParent(({ context }): CoordinatorParentEvent => ({ type: "COORD.RELEASE_READY", ...envelope(context) })),
      on: {
        "COORD.ACK": [{ guard: ({ context, event }) => matchesAck(context, event) }, { target: "failing", actions: "invalid" }],
        "COORD.RELEASE": [
          { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), target: "released" },
          { target: "failing", actions: "invalid" },
        ],
      },
    },
    released: { type: "final", entry: sendParent(({ context }): CoordinatorParentEvent => ({ type: "COORD.RELEASED", ...envelope(context) })) },
    failing: {
      entry: [sendParent(({ context }) => ({ type: "FAIL", error: context.failure?.error })), "failChild"],
      always: { guard: ({ context }) => !context.spawned || context.drained, target: "failedDrained" },
      on: {
        FAIL: {}, "COORD.ACK": {}, "COORD.ADMITTED": {}, "COORD.RELEASE": {}, "CHECKPOINT.REQUEST": {},
        "GRAPH.DRAINED": { guard: ({ context, event }) => matchesChild(context, event), target: "failedDrained", actions: ({ context }) => { context.drained = true; } },
      },
    },
    failedDrained: {
      entry: sendParent(({ context }): CoordinatorParentEvent => {
        if (!context.failure) throw new TypeError("Missing subgraph failure");
        return { type: "COORD.DRAINED", ...envelope(context), failure: context.failure };
      }),
      on: { FAIL: {}, "COORD.ACK": {}, "COORD.ADMITTED": {}, "COORD.RELEASE": {}, "COORD.CANCEL": {}, "CHECKPOINT.REQUEST": {}, "GRAPH.DRAINED": {} },
    },
  },
});
