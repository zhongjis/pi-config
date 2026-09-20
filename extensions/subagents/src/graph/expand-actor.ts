import { isDeepStrictEqual } from "node:util";
import { enqueueActions, sendParent, setup } from "xstate";
import { type CoordinatorChildEvent, type CoordinatorOperation, type CoordinatorParentEvent, type CoordinatorReceipt, type CoordinatorRequest, captureCoordinatorRequest, coordinatorReceipt } from "./coordinator-protocol.js";
import { namespaceFragment, parseFragment } from "./graph-fragment.js";

export interface ExpandInput {
  readonly receipt: CoordinatorReceipt;
  readonly source: unknown;
  readonly namespace?: string;
  readonly existingIds: readonly string[];
}
/** Volatile sequencing only: no host, planner, projection or persistence capability. */
export interface ExpandContext {
  readonly input: ExpandInput;
  readonly receipt: CoordinatorReceipt;
  request?: CoordinatorRequest;
  cancellation?: "cancel" | "lifecycle";
  failure?: { readonly error: unknown };
}
function prepare(context: ExpandContext): CoordinatorOperation {
  const { source, namespace, existingIds } = context.input; const id = context.receipt.id;
  if (context.cancellation) return { kind: "cancel", disposition: context.cancellation };
  if (source === null || typeof source !== "object" || Array.isArray(source)) return { kind: "fail", error: `expand node "${id}" source did not resolve to a GraphFragment` };
  try { return { kind: "insert", fragment: parseFragment(namespaceFragment(source, namespace), existingIds) }; }
  catch (error) { return { kind: "fail", error: `expand node "${id}" fragment is invalid: ${error instanceof Error ? error.message : String(error)}` }; }
}
function envelope(context: ExpandContext) { return { receipt: context.receipt, requestSequence: context.request?.requestSequence ?? 0 }; }
export const expandLogic = setup({
  types: { input: {} as ExpandInput, context: {} as ExpandContext, events: {} as CoordinatorChildEvent },
  actions: {
    invalid: ({ context }) => { context.failure ??= { error: new TypeError("Invalid coordinator handoff, acknowledgment or release") }; },
    request: enqueueActions(({ context, enqueue }) => {
      context.request = captureCoordinatorRequest({ type: "COORD.REQUEST", receipt: context.receipt, requestSequence: 1, operation: prepare(context) });
      enqueue.sendParent(context.request);
    }),
  },
}).createMachine({
  id: "expand", context: ({ input }) => ({ input, receipt: coordinatorReceipt(input.receipt) }), initial: "awaitingAdmission",
  on: {
    FAIL: { target: ".failedDrained", actions: ({ context, event }) => { context.failure ??= { error: event.error }; } },
    "COORD.CANCEL": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), actions: ({ context, event }) => { context.cancellation ??= event.disposition; } },
      { target: ".failedDrained", actions: "invalid" },
    ],
    "COORD.ADMITTED": { target: ".failedDrained", actions: "invalid" },
    "COORD.ACK": { target: ".failedDrained", actions: "invalid" },
    "COORD.RELEASE": { target: ".failedDrained", actions: "invalid" },
  },
  states: {
    awaitingAdmission: { on: { "COORD.ADMITTED": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), target: "preparing" },
      { target: "failedDrained", actions: "invalid" },
    ] } },
    preparing: { entry: "request", always: "waitingAck" },
    waitingAck: { on: { "COORD.ACK": [
      { guard: ({ context, event }) => isDeepStrictEqual(context.request, { ...event, type: "COORD.REQUEST" }), target: "releaseReady" },
      { target: "failedDrained", actions: "invalid" },
    ] } },
    releaseReady: {
      entry: sendParent(({ context }): CoordinatorParentEvent => ({ type: "COORD.RELEASE_READY", ...envelope(context) })),
      on: {
        "COORD.ACK": [
          { guard: ({ context, event }) => isDeepStrictEqual(context.request, { ...event, type: "COORD.REQUEST" }) },
          { target: "failedDrained", actions: "invalid" },
        ],
        "COORD.RELEASE": [
          { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), target: "released" },
          { target: "failedDrained", actions: "invalid" },
        ],
      },
    },
    released: { type: "final", entry: sendParent(({ context }): CoordinatorParentEvent => ({ type: "COORD.RELEASED", ...envelope(context) })) },
    failedDrained: {
      entry: sendParent(({ context }): CoordinatorParentEvent => {
        if (!context.failure) throw new TypeError("Missing coordinator failure");
        return { type: "COORD.DRAINED", ...envelope(context), failure: context.failure };
      }),
      on: { FAIL: {}, "COORD.ACK": {}, "COORD.ADMITTED": {}, "COORD.RELEASE": {}, "COORD.CANCEL": {} },
    },
  },
});
