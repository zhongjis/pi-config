import { isDeepStrictEqual } from "node:util";
import { enqueueActions, sendParent, setup } from "xstate";
import { type CollectionOwnerView, type CoordinatorChildEvent, type CoordinatorOperation, type CoordinatorParentEvent, type CoordinatorReceipt, type CoordinatorRequest, CoordinatorRequestJournal, captureCoordinatorRequest, coordinatorReceipt } from "./coordinator-protocol.js";

export interface FanoutInput {
  readonly receipt: CoordinatorReceipt;
  readonly view: CollectionOwnerView;
}
export interface FanoutContext {
  readonly receipt: CoordinatorReceipt;
  readonly journal: CoordinatorRequestJournal;
  view: CollectionOwnerView;
  request?: CoordinatorRequest;
  acknowledged: number;
  cancellation?: "cancel" | "lifecycle";
  failure?: { readonly error: unknown };
}
function envelope(context: FanoutContext) { return { receipt: context.receipt, requestSequence: context.request?.requestSequence ?? 0 }; }
/** Logical collection supervision only; root owns every leaf, transaction and executor slot. */
export const fanoutLogic = setup({
  types: { input: {} as FanoutInput, context: {} as FanoutContext, events: {} as CoordinatorChildEvent },
  actions: {
    invalid: ({ context }) => { context.failure ??= { error: new TypeError("Invalid fanout coordinator protocol") }; },
    request: enqueueActions(({ context, enqueue }) => {
      const operation: CoordinatorOperation = context.cancellation ? { kind: "cancel", disposition: context.cancellation } : { kind: context.view.materialized ? "aggregate" : "materialize" };
      context.request = captureCoordinatorRequest({ type: "COORD.REQUEST", receipt: context.receipt, requestSequence: context.acknowledged + 1, operation });
      context.journal.receive(context.request, context.receipt);
      enqueue.sendParent(context.request);
    }),
    acknowledge: ({ context, event }) => {
      if (event.type !== "COORD.ACK") return;
      try { context.journal.prepare(event); context.journal.commit(event); context.acknowledged = Math.max(context.acknowledged, event.requestSequence); }
      catch (error) { context.failure ??= { error }; } // no-excuse-ok: catch — coordinator boundary reports the exact protocol/infrastructure failure to root before release.
    },
  },
}).createMachine({
  id: "fanout", initial: "awaitingAdmission",
  context: ({ input }) => ({ receipt: coordinatorReceipt(input.receipt), journal: new CoordinatorRequestJournal(input.receipt), view: { ...input.view }, acknowledged: 0 }),
  on: {
    FAIL: { target: ".failedDrained", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } },
    "COORD.CANCEL": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), actions: ({ context, event }) => { context.cancellation ??= event.disposition; } },
      { target: ".failedDrained", actions: "invalid" },
    ],
    "COORD.VIEW": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), actions: ({ context, event }) => { if (event.view.revision >= context.view.revision) context.view = { ...event.view }; } },
      { target: ".failedDrained", actions: "invalid" },
    ],
    "COORD.ACK": { actions: "acknowledge" },
    "COORD.ADMITTED": { target: ".failedDrained", actions: "invalid" },
    "COORD.RELEASE": { target: ".failedDrained", actions: "invalid" },
  },
  states: {
    awaitingAdmission: { always: { guard: ({ context }) => !!context.failure, target: "failedDrained" }, on: { "COORD.ADMITTED": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), target: "collecting" },
      { target: "failedDrained", actions: "invalid" },
    ] } },
    collecting: { always: [
      { guard: ({ context }) => !!context.failure, target: "failedDrained" },
      { guard: ({ context }) => context.view.settled && context.acknowledged > 0, target: "releaseReady" },
      { guard: ({ context }) => !!context.cancellation || !context.view.materialized || context.view.ready, target: "requesting" },
    ] },
    requesting: { entry: "request", always: "waitingAck" },
    waitingAck: { always: [
      { guard: ({ context }) => !!context.failure, target: "failedDrained" },
      { guard: ({ context }) => context.acknowledged === context.request?.requestSequence && (context.request?.operation.kind === "cancel" || context.request?.operation.kind === "aggregate"), target: "releaseReady" },
      // The materialization ACK authorizes no second request until its committed owner view arrives.
      { guard: ({ context }) => context.acknowledged === context.request?.requestSequence && (!!context.cancellation || context.view.materialized || context.view.settled), target: "collecting" },
    ] },
    releaseReady: {
      entry: sendParent(({ context }): CoordinatorParentEvent => ({ type: "COORD.RELEASE_READY", ...envelope(context) })),
      always: { guard: ({ context }) => !!context.failure, target: "failedDrained" },
      on: { "COORD.RELEASE": [
        { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), target: "released" },
        { target: "failedDrained", actions: "invalid" },
      ] },
    },
    released: { type: "final", entry: sendParent(({ context }): CoordinatorParentEvent => ({ type: "COORD.RELEASED", ...envelope(context) })) },
    failedDrained: {
      entry: sendParent(({ context }): CoordinatorParentEvent => {
        if (!context.failure) throw new TypeError("Missing coordinator failure");
        return { type: "COORD.DRAINED", ...envelope(context), failure: context.failure };
      }),
      on: { FAIL: {}, "COORD.ACK": {}, "COORD.VIEW": {}, "COORD.ADMITTED": {}, "COORD.RELEASE": {}, "COORD.CANCEL": {} },
    },
  },
});
