import { randomUUID } from "node:crypto";
import { createActor, setup } from "xstate";
import { executionAttemptId } from "../src/graph/graph-execution.js";
import { GraphInstances } from "../src/graph/graph-instance-id.js";
import { compileJsonSchema } from "../src/graph/json-schema.js";
import { agentNodeLogic, humanGateNodeLogic } from "../src/graph/node-lifecycle.js";
import type { AgentLifecycleInput, HumanGateLifecycleInput, NodeLifecycleInput } from "../src/graph/node-lifecycle-session.js";
import { admissionReceipt, type NodeAck, type NodeAdmissionReceipt, type NodeChildEvent, type NodeParentEvent, type NodeRequest } from "../src/graph/node-protocol.js";

export function receipt(): NodeAdmissionReceipt {
  return admissionReceipt({ id: "a", incarnation: randomUUID(), executionSequence: 1, correlation: {
    runId: "machine", instanceId: new GraphInstances("machine").add("a", { nodeKey: "a" }).instanceId,
    activation: 1, graphAttempt: 1, executionAttemptId: executionAttemptId(randomUUID()),
  } });
}
export function repaired(prior: NodeAdmissionReceipt): NodeAdmissionReceipt {
  return admissionReceipt({ ...prior, executionSequence: prior.executionSequence + 1,
    correlation: { ...prior.correlation, executionAttemptId: executionAttemptId(randomUUID()) } });
}
export function agentInput(overrides: Partial<AgentLifecycleInput> = {}): AgentLifecycleInput {
  return { receipt: receipt(), host: { spawnAgent: async () => ({ ok: true }) },
    node: { kind: "agent", nodeId: "a", agentType: "worker", prompt: "fixture" }, ...overrides };
}
export function humanInput(overrides: Partial<HumanGateLifecycleInput> = {}): HumanGateLifecycleInput {
  return { receipt: receipt(), host: { spawnAgent: async () => { throw new TypeError("Unexpected spawn"); }, awaitHumanGate: async () => ({ ok: true }) },
    node: { kind: "human", nodeId: "a", prompt: "fixture" }, ...overrides };
}
export function schema() {
  const result = compileJsonSchema({ type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false });
  if (!result.ok) throw new TypeError(result.message);
  return result.compiled;
}
export function machine(input: NodeLifecycleInput) {
  const events: NodeParentEvent[] = [];
  const listeners = new Set<(event: NodeParentEvent) => void>();
  const record = (event: NodeParentEvent) => { events.push(event); for (const listener of listeners) listener(event); };
  const logic = setup({ actors: { node: input.node.kind === "agent" ? agentNodeLogic : humanGateNodeLogic },
    types: { events: {} as NodeParentEvent },
  }).createMachine({
    invoke: { id: "node", src: "node", input },
    on: { "NODE.REQUEST": { actions: ({ event }) => record(event) }, "NODE.RESOLVED": { actions: ({ event }) => record(event) },
      "NODE.DRAINED": { actions: ({ event }) => record(event) }, "NODE.RELEASE_READY": { actions: ({ event }) => record(event) } },
  });
  const parent = createActor(logic).start();
  const child = parent.getSnapshot().children.node;
  if (!child) throw new TypeError("Missing node actor");
  const send = (event: NodeChildEvent) => child.send(event);
  const next = <Type extends NodeParentEvent["type"]>(type: Type, after = 0): Promise<Extract<NodeParentEvent, { type: Type }>> => {
    const matches = (event: NodeParentEvent): event is Extract<NodeParentEvent, { type: Type }> => event.type === type;
    const existing = events.slice(after).find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const listener = (event: NodeParentEvent) => { if (matches(event)) { listeners.delete(listener); resolve(event); } };
      listeners.add(listener);
    });
  };
  const ack = (request: NodeRequest, committed = input.receipt): NodeAck => {
    const value: NodeAck = { ...request, type: "NODE.ACK", receipt: committed };
    send(value);
    return value;
  };
  return { parent, child, events, send, next, ack, admit: () => send({ type: "NODE.ADMITTED", receipt: input.receipt }) };
}
export async function terminal(input: NodeLifecycleInput) {
  const actor = machine(input);
  actor.admit();
  let latest = input.receipt;
  let offset = 0;
  for (;;) {
    const request = await actor.next("NODE.REQUEST", offset);
    offset = actor.events.length;
    if (request.operation.kind === "repair") latest = repaired(latest);
    actor.ack(request, latest);
    if (request.operation.kind === "settle") {
      await actor.next("NODE.RELEASE_READY");
      actor.send({ type: "NODE.RELEASE", receipt: latest });
      const result = request.operation.result;
      actor.parent.stop();
      return { result, events: actor.events };
    }
  }
}
