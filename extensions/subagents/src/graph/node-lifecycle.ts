import { isDeepStrictEqual } from "node:util";
import { enqueueActions, sendParent, setup } from "xstate";
import { checkNodeSchema } from "./node-actor.js";
import { gateNodeEffect, humanNodeEffect, spawnNodeEffect } from "./node-effects.js";
import { type AgentLifecycleInput, acceptAck, acceptReceipt, envelope, failNode, type HumanGateLifecycleInput, type NodeLifecycleEvent, type NodeLifecycleInput, type NodeSession, nodeRequest, nodeSession, settlement } from "./node-lifecycle-session.js";
import type { NodeParentEvent } from "./node-protocol.js";

/** Shared protocol states, specialized input types; no whole-node promise actor. */
function lifecycle<Input extends NodeLifecycleInput>(id: string) {
  return setup({
    types: { context: {} as NodeSession, input: {} as Input, events: {} as NodeLifecycleEvent },
    actors: { spawn: spawnNodeEffect, gate: gateNodeEffect, human: humanNodeEffect },
    guards: {
      blocked: ({ context }) => Boolean(context.failure || context.cancellation),
      failed: ({ context }) => Boolean(context.failure),
      agent: ({ context }) => context.input.node.kind === "agent",
      needsGate: ({ context }) => context.result.ok && context.input.node.kind === "agent" && context.input.node.gate !== undefined,
      canRepair: ({ context }) => context.input.node.kind === "agent" && !context.result.ok && !context.result.skipped &&
        context.receipt.executionSequence < Math.max(1, context.input.node.maxAttempts ?? 1),
    },
    actions: {
      askCancel: enqueueActions(({ context, enqueue }) => {
        if (context.admitted && context.cancellation && !context.pending && !context.failure && !context.cancelAcknowledged && !context.settled) {
          enqueue.sendParent(nodeRequest(context, { kind: "cancel", disposition: context.cancellation.disposition }));
        }
      }),
      askGate: enqueueActions(({ context, enqueue }) => { enqueue.sendParent(nodeRequest(context, { kind: "gate", costUsd: context.result.costUsd })); }),
      askRepair: enqueueActions(({ context, enqueue }) => { enqueue.sendParent(nodeRequest(context, { kind: "repair", result: context.result, executed: context.executed })); }),
      askSettlement: enqueueActions(({ context, enqueue }) => {
        const operation = settlement(context);
        if (operation.kind === "settle") context.result = operation.result;
        enqueue.sendParent(nodeRequest(context, operation));
      }),
      beginEffect: ({ context }) => { context.active = true; context.continuation = undefined; },
      checkSchema: ({ context }) => {
        if (context.failure || context.cancellation || !context.result.ok || !context.input.node.schema) return;
        context.result = checkNodeSchema(context.result, context.input.node.schema);
      },
    },
  }).createMachine({
    id,
    context: ({ input }) => nodeSession(input),
    initial: "awaitingAdmission",
    on: {
      "NODE.ADMITTED": { actions: ({ context, event }) => { acceptReceipt(context, event.receipt); } },
      "NODE.ACK": { actions: ({ context, event }) => { acceptAck(context, event); } },
      "NODE.RELEASE": { actions: ({ context }) => { failNode(context, new TypeError("Node released before settlement acknowledgment")); } },
      CANCEL: { actions: [({ context, event }) => {
        context.cancellation ??= { disposition: event.disposition, reason: event.reason };
      }, "askCancel"] },
      FAIL: { actions: ({ context, event }) => { failNode(context, event.error); } },
      "NODE.RESOLVED": { guard: ({ context, event }) => context.active && !context.cancellation && !context.failure &&
        !context.controller.signal.aborted && event.id === context.receipt.id && event.incarnation === context.receipt.incarnation &&
        isDeepStrictEqual(event.correlation, context.receipt.correlation), actions: sendParent(({ event }): NodeParentEvent => event) },
    },
    states: {
      awaitingAdmission: {
        always: { guard: "failed", target: "failedDrained" },
        on: { "NODE.ADMITTED": { target: "ready", actions: ({ context, event }) => { context.admitted = acceptReceipt(context, event.receipt); } } },
      },
      ready: { always: [{ guard: "blocked", target: "waiting" }, { guard: "agent", target: "spawning" }, { target: "prompting" }] },
      spawning: {
        entry: "beginEffect",
        invoke: { src: "spawn", input: ({ context, self }) => ({ context, resolved: event => self.send(event) }),
          onDone: { target: "schema", actions: ({ context, event }) => { context.active = false; context.result = event.output.result; context.executed = event.output.executed; } },
          onError: { target: "waiting", actions: ({ context, event }) => { context.active = false; failNode(context, event.error); } },
        },
      },
      prompting: {
        entry: "beginEffect",
        invoke: { src: "human", input: ({ context, self }) => ({ context, resolved: event => self.send(event) }),
          onDone: { target: "schema", actions: ({ context, event }) => { context.active = false; context.result = event.output.result; context.executed = event.output.executed; } },
          onError: { target: "waiting", actions: ({ context, event }) => { context.active = false; failNode(context, event.error); } },
        },
      },
      schema: {
        entry: "checkSchema",
        always: [{ guard: "blocked", target: "waiting" }, { guard: "needsGate", target: "requestingGate" }, { target: "outcome" }],
      },
      requestingGate: { entry: "askGate", always: "waiting" },
      gating: {
        entry: "beginEffect",
        invoke: { src: "gate", input: ({ context, self }) => ({ context, resolved: event => self.send(event) }),
          onDone: { target: "outcome", actions: ({ context, event }) => { context.active = false; context.result = event.output.result; context.executed = event.output.executed; } },
          onError: { target: "waiting", actions: ({ context, event }) => { context.active = false; failNode(context, event.error); } },
        },
      },
      outcome: { always: [{ guard: "blocked", target: "waiting" }, { guard: "canRepair", target: "requestingRepair" }, { target: "requestingSettlement" }] },
      requestingRepair: { entry: "askRepair", always: "waiting" },
      requestingSettlement: { entry: "askSettlement", always: "waiting" },
      waiting: {
        always: [
          { guard: "failed", target: "failedDrained" },
          { guard: ({ context }) => context.settled, target: "settledAwaitingRelease" },
          { guard: ({ context }) => Boolean(context.cancellation && !context.pending && !context.cancelAcknowledged), actions: "askCancel" },
          { guard: ({ context }) => context.cancelAcknowledged && !context.pending, target: "requestingSettlement" },
          { guard: ({ context }) => !context.cancellation && !context.pending && context.continuation === "spawn", target: "ready" },
          { guard: ({ context }) => !context.cancellation && !context.pending && context.continuation === "gate", target: "gating" },
        ],
      },
      settledAwaitingRelease: {
        entry: sendParent(({ context }): NodeParentEvent => ({ type: "NODE.RELEASE_READY", ...envelope(context) })),
        always: { guard: "failed", target: "failedDrained" },
        on: {
          CANCEL: {},
          "NODE.RELEASE": [
            { guard: ({ context, event }) => isDeepStrictEqual(context.receipt, event.receipt), target: "released" },
            { actions: ({ context, event }) => { acceptReceipt(context, event.receipt); } },
          ],
        },
      },
      failedDrained: {
        entry: sendParent(({ context }): NodeParentEvent => {
          if (!context.failure) throw new TypeError("Failure drain requires infrastructure error");
          return { type: "NODE.DRAINED", ...envelope(context), failure: context.failure };
        }),
        on: { "NODE.ACK": {}, "NODE.ADMITTED": {}, "NODE.RELEASE": {}, CANCEL: {}, FAIL: {}, "NODE.RESOLVED": {} },
      },
      released: { type: "final", entry: sendParent(({ context }): NodeParentEvent => ({ type: "NODE.RELEASED", ...envelope(context) })) },
    },
    output: ({ context }) => context.result,
  });
}

export const agentNodeLogic = lifecycle<AgentLifecycleInput>("agentNode");
export const humanGateNodeLogic = lifecycle<HumanGateLifecycleInput>("humanGateNode");
