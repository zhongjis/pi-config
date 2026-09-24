import type { ExecutionCorrelation } from "./graph-execution.js";
/**
 * node-host.ts — the seam between a graph node and the subagent execution core.
 *
 * A graph-native replacement for the script runtime's `WorkflowHost`. The node
 * effects (node-effects.ts) know only this interface, so typed lifecycle actors
 * run against a test stub or the real `AgentManager` adapter. Deliberately free
 * of XState or IR types: each effect takes a request and AbortSignal, and must
 * physically settle even after the lifecycle actor acknowledges cancellation.
 *
 * The real adapter (host.ts, reworked in a later phase) implements this by
 * resolving the agent type/model, spawning through `AgentManager`, and mapping
 * the record back to {@link NodeSpawnResult}.
 */

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

/** A pause point awaiting a human decision (approve / reject / supply data). */
export interface HumanGateRequest {
  correlation?: ExecutionCorrelation;
  nodeId: string;
  prompt: string;
  /** The shape the human's response must satisfy. */
  schema?: CompiledSchema;
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
  reconcileDrain?(correlation: ExecutionCorrelation, target: "agent" | "human-gate" | "validation-gate"): Promise<boolean>;
  spawnAgent(request: NodeSpawnRequest, signal: AbortSignal): Promise<NodeSpawnResult>;
  runGate?(command: string, options: { cwd?: string; signal: AbortSignal; correlation?: ExecutionCorrelation }): Promise<NodeGateResult>;
  /**
   * Await a human decision for a `human_gate` node. The result's `output` is the
   * human-supplied value (JSON when a schema is set). A host without this fails a
   * human_gate loudly rather than passing it unattended.
   */
  awaitHumanGate?(request: HumanGateRequest, signal: AbortSignal): Promise<NodeSpawnResult>;
}
