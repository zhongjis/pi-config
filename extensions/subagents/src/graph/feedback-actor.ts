import { isDeepStrictEqual } from "node:util";
import { enqueueActions, sendParent, setup } from "xstate";
import { type CoordinatorChildEvent, type CoordinatorOperation, type CoordinatorParentEvent, type CoordinatorReceipt, type CoordinatorRequest, CoordinatorRequestJournal, captureCoordinatorRequest, coordinatorReceipt, type FeedbackOwnerView } from "./coordinator-protocol.js";

export interface FeedbackInput {
  readonly receipt: CoordinatorReceipt;
  readonly view: FeedbackOwnerView;
}
export interface FeedbackContext {
  readonly receipt: CoordinatorReceipt;
  readonly journal: CoordinatorRequestJournal;
  view: FeedbackOwnerView;
  request?: CoordinatorRequest;
  requestedRevision: number;
  acknowledged: number;
  cancellation?: "cancel" | "lifecycle";
  failure?: { readonly error: unknown };
}
function envelope(context: FeedbackContext) { return { receipt: context.receipt, requestSequence: context.request?.requestSequence ?? 0 }; }
/** Sequencing only: every work coordinator and leaf is owned independently by root. */
export const feedbackLogic = setup({
  types: { input: {} as FeedbackInput, context: {} as FeedbackContext, events: {} as CoordinatorChildEvent },
  actions: {
    invalid: ({ context }) => { context.failure ??= { error: new TypeError("Invalid feedback coordinator protocol") }; },
    request: enqueueActions(({ context, enqueue }) => {
      let operation: CoordinatorOperation;
      if (context.cancellation) operation = { kind: "cancel", disposition: context.cancellation };
      else switch (context.view.phase) {
        case "absent": operation = { kind: "feedback-intent" }; break;
        case "intent": operation = { kind: "feedback-materialize", iteration: context.view.iteration }; break;
        case "decision": operation = { kind: "feedback-decision", iteration: context.view.iteration }; break;
        default: throw new TypeError("Feedback owner is not ready for a transaction");
      }
      context.requestedRevision = context.view.revision;
      context.request = captureCoordinatorRequest({ type: "COORD.REQUEST", receipt: context.receipt, requestSequence: context.acknowledged + 1, operation });
      context.journal.receive(context.request, context.receipt);
      enqueue.sendParent(context.request);
    }),
    acknowledge: ({ context, event }) => {
      if (event.type !== "COORD.ACK") return;
      try { context.journal.prepare(event); context.journal.commit(event); context.acknowledged = Math.max(context.acknowledged, event.requestSequence); }
      catch (error) { context.failure ??= { error }; } // no-excuse-ok: catch — report exact protocol failure through root drain.
    },
  },
}).createMachine({
  id: "feedback", initial: "awaitingAdmission",
  context: ({ input }) => ({ receipt: coordinatorReceipt(input.receipt), journal: new CoordinatorRequestJournal(input.receipt), view: { ...input.view }, requestedRevision: -1, acknowledged: 0 }),
  on: {
    FAIL: { target: ".failedDrained", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } },
    "COORD.CANCEL": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), actions: ({ context, event }) => { context.cancellation ??= event.disposition; } },
      { target: ".failedDrained", actions: "invalid" },
    ],
    "COORD.FEEDBACK_VIEW": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), actions: ({ context, event }) => { if (event.view.revision >= context.view.revision) context.view = { ...event.view }; } },
      { target: ".failedDrained", actions: "invalid" },
    ],
    "COORD.ACK": { actions: "acknowledge" },
    "COORD.ADMITTED": { target: ".failedDrained", actions: "invalid" },
    "COORD.RELEASE": { target: ".failedDrained", actions: "invalid" },
  },
  states: {
    awaitingAdmission: { always: { guard: ({ context }) => !!context.failure, target: "failedDrained" }, on: { "COORD.ADMITTED": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), target: "observing" },
      { target: "failedDrained", actions: "invalid" },
    ] } },
    observing: { always: [
      { guard: ({ context }) => !!context.failure, target: "failedDrained" },
      { guard: ({ context }) => context.view.phase === "terminal" && context.acknowledged > 0, target: "releaseReady" },
      { guard: ({ context }) => !!context.cancellation || ["absent", "intent", "decision"].includes(context.view.phase), target: "requesting" },
    ] },
    requesting: { entry: "request", always: "waitingAck" },
    waitingAck: { always: [
      { guard: ({ context }) => !!context.failure, target: "failedDrained" },
      { guard: ({ context }) => context.acknowledged === context.request?.requestSequence && context.request?.operation.kind === "cancel", target: "releaseReady" },
      // Both the commit ACK and its newer owner view must arrive before another request.
      { guard: ({ context }) => {
        if (context.acknowledged !== context.request?.requestSequence) return false;
        if (context.cancellation) return true;
        if (context.view.revision <= context.requestedRevision) return false;
        switch (context.request.operation.kind) {
          case "feedback-intent": return context.view.phase !== "absent";
          case "feedback-materialize": return context.view.phase !== "intent";
          case "feedback-decision": return context.view.phase === "intent" || context.view.phase === "terminal";
          default: return false;
        }
      }, target: "observing" },
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
      on: { FAIL: {}, "COORD.ACK": {}, "COORD.FEEDBACK_VIEW": {}, "COORD.ADMITTED": {}, "COORD.RELEASE": {}, "COORD.CANCEL": {} },
    },
  },
});
