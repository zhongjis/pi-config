import { fromPromise } from "xstate";
import type { NodeSpawnResult } from "./node-host.js";
import { envelope, type NodeResolution, type NodeSession } from "./node-lifecycle-session.js";

export interface NodeEffectInput {
  readonly context: NodeSession;
  readonly resolved: (event: NodeResolution) => void;
}
export interface NodeEffectResult {
  readonly result: NodeSpawnResult;
  readonly executed: boolean;
}
const aborted = (): NodeSpawnResult => ({ ok: false, skipped: true, error: "Aborted." });

/** Exactly one host spawn. Schema, retries, and checkpoints belong to the machine. */
export const spawnNodeEffect = fromPromise<NodeEffectResult, NodeEffectInput>(async ({ input, signal }) => {
  await Promise.resolve();
  const context = input.context;
  const { host, node, authorize } = context.input;
  if (node.kind !== "agent") throw new TypeError("Agent effect requires an agent node");
  const abort = AbortSignal.any([signal, context.controller.signal]);
  if (context.cancellation || context.failure || abort.aborted) return { result: aborted(), executed: false };
  const identity = envelope(context);
  const denied = authorize?.();
  if (denied) return { result: { ok: false, error: denied }, executed: false };
  if (context.cancellation || context.failure || abort.aborted) return { result: aborted(), executed: false };
  let active = true;
  try {
    const result = await host.spawnAgent({ nodeId: node.nodeId, prompt: node.prompt, agentType: node.agentType,
      attempt: context.receipt.executionSequence, correlation: identity.correlation, ...(node.schema ? { schema: node.schema } : {}),
      onResolved: info => { if (active && !abort.aborted) input.resolved({ type: "NODE.RESOLVED", ...identity, info }); },
    }, abort);
    return { result, executed: true };
  } catch (error) {
    return { result: { ok: false, error: error instanceof Error ? error.message : String(error) }, executed: true };
  } finally { active = false; }
});

/** Exactly one validation command, with capability checked after its ACK. */
export const gateNodeEffect = fromPromise<NodeEffectResult, NodeEffectInput>(async ({ input, signal }) => {
  await Promise.resolve();
  const context = input.context;
  const { host, node } = context.input;
  if (node.kind !== "agent" || node.gate === undefined) throw new TypeError("Gate effect requires a gate command");
  const abort = AbortSignal.any([signal, context.controller.signal]);
  if (context.cancellation || context.failure || abort.aborted) return { result: aborted(), executed: context.executed };
  if (!host.runGate) return { result: { ...context.result, ok: false, error: "This host cannot run gate commands." }, executed: context.executed };
  try {
    const gate = await host.runGate(node.gate, { cwd: context.result.cwd, signal: abort, correlation: context.receipt.correlation });
    return { result: gate.ok ? context.result : { ...context.result, ok: false, error: gate.output.trim() || `Gate command failed: ${node.gate}` }, executed: context.executed };
  } catch (error) {
    return { result: { ...context.result, ok: false, error: error instanceof Error ? error.message : String(error) }, executed: context.executed };
  }
});

/** Exactly one prompt; abort never substitutes for the prompt's physical settlement. */
export const humanNodeEffect = fromPromise<NodeEffectResult, NodeEffectInput>(async ({ input, signal }) => {
  await Promise.resolve();
  const context = input.context;
  const { host, node, authorize } = context.input;
  const abort = AbortSignal.any([signal, context.controller.signal]);
  if (context.cancellation || context.failure || abort.aborted) return { result: aborted(), executed: false };
  const denied = authorize?.();
  if (denied) return { result: { ok: false, error: denied }, executed: false };
  if (context.cancellation || context.failure || abort.aborted) return { result: aborted(), executed: false };
  try {
    const result = host.awaitHumanGate ? await host.awaitHumanGate({ nodeId: node.nodeId, prompt: node.prompt,
      correlation: context.receipt.correlation, ...(node.schema ? { schema: node.schema } : {}),
    }, abort) : { ok: false, error: "This host cannot await human input" };
    return { result, executed: false };
  } catch (error) { return { result: { ok: false, error: error instanceof Error ? error.message : String(error) }, executed: false }; }
});
