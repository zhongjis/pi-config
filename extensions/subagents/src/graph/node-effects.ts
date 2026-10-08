import { fromPromise } from "xstate";
import { escalationReason, lowestConfidence, responseToOutput } from "./decision-gate.js";
import type { NodeSpawnResult } from "./node-host.js";
import { type DecisionLifecycleInput, envelope, type NodeResolution, type NodeSession } from "./node-lifecycle-session.js";

export interface NodeEffectInput {
  readonly context: NodeSession;
  readonly resolved: (event: NodeResolution) => void;
}
export interface NodeEffectResult {
  readonly result: NodeSpawnResult;
  readonly executed: boolean;
  readonly undecidedReason?: string;
}
const aborted = (): NodeSpawnResult => ({ ok: false, skipped: true, error: "Aborted." });
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const REPAIR_TAIL = 2000;
const NO_DECIDE = "This host cannot run decision models";
function spawnPrompt(context: NodeSession, prompt: string): string {
  const error = context.repairError;
  const attempt = context.receipt.executionSequence;
  if (attempt <= 1 || !error) return prompt;
  const tail = error.length > REPAIR_TAIL ? error.slice(-REPAIR_TAIL) : error;
  return `${prompt}\n\nPrevious attempt ${attempt - 1} failed:\n${tail}\nReturn a corrected result.`;
}

/** One decision-model chain; anything short of a confident answer escalates unless aborted. */
async function decide(input: NodeEffectInput, node: DecisionLifecycleInput["node"], abort: AbortSignal): Promise<NodeEffectResult> {
  const context = input.context;
  const { host } = context.input;
  if (!host.decide) return { result: { ok: false, error: NO_DECIDE, costUsd: 0 }, executed: false, undecidedReason: NO_DECIDE };
  const identity = envelope(context);
  let active = true;
  let costUsd: number | undefined;
  try {
    const decision = await host.decide({ nodeId: node.nodeId, state: node.state, questions: node.questions, correlation: identity.correlation,
      onResolved: info => { if (active && !abort.aborted) input.resolved({ type: "NODE.RESOLVED", ...identity, info }); },
    }, abort);
    costUsd = decision.costUsd;
    const cost = costUsd === undefined ? {} : { costUsd };
    if (abort.aborted || (!decision.ok && decision.skipped)) return { result: { ...aborted(), ...cost }, executed: true };
    if (!decision.ok) return { result: { ok: false, error: decision.error, ...cost }, executed: true, undecidedReason: escalationReason({ kind: "exhausted", error: decision.error }) };
    const output = { answers: decision.answers, decidedBy: decision.decidedBy };
    if (lowestConfidence(decision.answers) >= node.minConfidence) return { result: { ok: true, output: JSON.stringify(output), ...cost }, executed: true };
    return { result: { ok: false, error: "Decision confidence below threshold", ...cost }, executed: true,
      undecidedReason: escalationReason({ kind: "low-confidence", answers: decision.answers, minConfidence: node.minConfidence, decidedBy: decision.decidedBy, model: decision.model }) };
  } catch (error) {
    const cost = costUsd === undefined ? {} : { costUsd };
    if (abort.aborted) return { result: { ...aborted(), ...cost }, executed: true };
    return { result: { ok: false, error: message(error), ...cost }, executed: true, undecidedReason: escalationReason({ kind: "exhausted", error: message(error) }) };
  } finally { active = false; }
}

/** Exactly one host spawn or decision chain. Schema, retries, and checkpoints belong to the machine. */
export const spawnNodeEffect = fromPromise<NodeEffectResult, NodeEffectInput>(async ({ input, signal }) => {
  await Promise.resolve();
  const context = input.context;
  const { host, node, authorize } = context.input;
  const abort = AbortSignal.any([signal, context.controller.signal]);
  if (context.cancellation || context.failure || abort.aborted) return { result: aborted(), executed: false };
  if (node.kind === "decision") {
    if (node.escalationOnly) throw new TypeError("Escalation-only decision cannot run models");
    return decide(input, node, abort);
  }
  const identity = envelope(context);
  const denied = authorize?.();
  if (denied) return { result: { ok: false, error: denied }, executed: false };
  if (context.cancellation || context.failure || abort.aborted) return { result: aborted(), executed: false };
  let active = true;
  try {
    const result = await host.spawnAgent({ nodeId: node.nodeId, prompt: spawnPrompt(context, node.prompt), agentType: node.agentType,
      attempt: context.receipt.executionSequence, correlation: identity.correlation, ...(node.schema ? { schema: node.schema } : {}),
      onResolved: info => { if (active && !abort.aborted) input.resolved({ type: "NODE.RESOLVED", ...identity, info }); },
    }, abort);
    return { result, executed: true };
  } catch (error) {
    return { result: { ok: false, error: message(error) }, executed: true };
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

/** Exactly one escalation; abort never substitutes for the handoff's physical settlement. */
export const escalationNodeEffect = fromPromise<NodeEffectResult, NodeEffectInput>(async ({ input, signal }) => {
  await Promise.resolve();
  const context = input.context;
  const { host, node } = context.input;
  if (node.kind !== "decision") throw new TypeError("Escalation effect requires a decision node");
  const reason = context.undecidedReason ?? node.escalationReason;
  if (!reason) throw new TypeError("Missing escalation reason");
  const abort = AbortSignal.any([signal, context.controller.signal]);
  if (context.cancellation || context.failure || abort.aborted) return { result: aborted(), executed: context.executed };
  if (!host.awaitEscalation) return { result: { ok: false, error: "This host cannot escalate decisions" }, executed: context.executed };
  try {
    const result = await host.awaitEscalation({ nodeId: node.nodeId, correlation: context.receipt.correlation, reason,
      questions: node.questions, state: node.state, schema: node.responseSchema }, abort);
    if (!result.ok) return { result, executed: context.executed };
    // The exposed schema checks the mapped output, never the raw response.
    return { result: { ...result, output: JSON.stringify(responseToOutput(node.questions, JSON.parse(result.output ?? "null"))) }, executed: context.executed };
  } catch (error) { return { result: { ok: false, error: message(error) }, executed: context.executed }; }
});
