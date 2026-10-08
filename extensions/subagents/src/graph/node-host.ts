import type { DecisionAnswer } from "./decision-gate.js";
import type { ExecutionCorrelation } from "./graph-execution.js";
/**
 * node-host.ts — the seam between a graph node and the subagent execution core.
 *
 * A graph-native replacement for the script runtime's `WorkflowHost`. The node
 * effects (node-effects.ts) know only this interface, so typed lifecycle actors
 * run against a test stub or the real `AgentManager` adapter. Deliberately free
 * of XState and graph-node types: each effect takes a request and AbortSignal, and
 * must physically settle even after the lifecycle actor acknowledges cancellation.
 *
 * The real adapter (host.ts, reworked in a later phase) implements this by
 * resolving the agent type/model, spawning through `AgentManager`, and mapping
 * the record back to {@link NodeSpawnResult}.
 */

import type { ClassifierQuestion } from "./ir.js";
import type { CompiledSchema } from "./json-schema.js";

/** What the host reports once the child's effective config is known. */
export interface NodeResolvedInfo {
  recordId?: string;
  modelName?: string;
  modelId?: string;
  thinking?: string;
  requestedModel?: string;
  requestedThinking?: string;
}

/** One agent spawn for a single node attempt. */
export interface NodeSpawnRequest {
  correlation?: ExecutionCorrelation;
  /** Stable node identity in the run graph. */
  nodeId: string;
  /** 1-based execution count within the current graph attempt. */
  attempt: number;
  agentType: string;
  prompt: string;
  /**
   * Compiled output schema. When present the host must give the child a
   * `StructuredOutput` tool and return the validated JSON as {@link NodeSpawnResult.output}.
   */
  schema?: CompiledSchema;
  /** Called once the child's effective model/id/thinking is known. */
  onResolved?(info: NodeResolvedInfo): void;
}

export interface NodeSpawnResult {
  ok: boolean;
  /** The agent's answer: final text, or validated JSON when a schema was given. */
  output?: string;
  /** Why it failed. Present when not `ok`. */
  error?: string;
  /** The user dismissed it rather than it failing; renders as skipped. */
  skipped?: boolean;
  /** Authoritative lifetime cost of this child execution in USD; absent means unavailable. */
  costUsd?: number;
  tokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  /** Effective child working directory; a gate runs here. */
  cwd?: string;
}

/** Outcome of a deterministic validation gate command. */
export interface NodeGateResult {
  ok: boolean;
  output: string;
}

/** One decision-model chain run over a decision_gate's resolved state. */
export interface DecisionRequest {
  correlation?: ExecutionCorrelation;
  nodeId: string;
  state: Record<string, unknown>;
  questions: Record<string, ClassifierQuestion>;
  /** Called once the deciding model is known. */
  onResolved?(info: NodeResolvedInfo): void;
}

/** `costUsd` absent means cost is unavailable; 0 is a real zero. */
export type DecisionResult =
  | { readonly ok: true; readonly answers: Record<string, DecisionAnswer>; readonly decidedBy: "classifier" | "agent"; readonly model: string; readonly costUsd?: number }
  | { readonly ok: false; readonly error: string; readonly skipped?: boolean; readonly costUsd?: number };

/** An undecided decision_gate awaiting the invoking orchestrator. */
export interface EscalationRequest {
  correlation?: ExecutionCorrelation;
  nodeId: string;
  reason: string;
  questions: Record<string, ClassifierQuestion>;
  state: Record<string, unknown>;
  /** The shape the orchestrator's response must satisfy. */
  schema: CompiledSchema;
}

/**
 * The one seam a graph run needs into the rest of the extension.
 *
 * `runGate` is optional for the same reason it was in the script runtime: a host
 * that cannot run a command must fail a gated node loudly rather than pass it
 * unverified — the node actor rechecks capability immediately before the effect.
 */
export interface NodeHost {
  /** Invoked only after the previous checkpoint writer has been proven dead. */
  reconcileDrain?(correlation: ExecutionCorrelation, target: "agent" | "escalation" | "validation-gate"): Promise<boolean>;
  spawnAgent(request: NodeSpawnRequest, signal: AbortSignal): Promise<NodeSpawnResult>;
  runGate?(command: string, options: { cwd?: string; signal: AbortSignal; correlation?: ExecutionCorrelation }): Promise<NodeGateResult>;
  /** Run the decision-model chain for a decision_gate. A host without it escalates every decision. */
  decide?(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
  /**
   * Await the orchestrator's decision for an escalated decision_gate. The result's
   * `output` is the response JSON. A host without this fails the escalation loudly
   * rather than passing it unattended.
   */
  awaitEscalation?(request: EscalationRequest, signal: AbortSignal): Promise<NodeSpawnResult>;
}
