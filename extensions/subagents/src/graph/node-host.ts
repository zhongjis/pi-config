/**
 * node-host.ts — the seam between a graph node and the subagent execution core.
 *
 * A graph-native replacement for the script runtime's `WorkflowHost`. The node
 * actor (node-actor.ts) knows only this interface, so the same actor runs against
 * a test stub or the real `AgentManager` adapter. Deliberately free of any XState
 * or IR type: it speaks in a single spawn request and a single result, and takes
 * an `AbortSignal` directly so cancellation is the caller's `actor.stop()`.
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
  /** Stable node identity in the run graph. */
  nodeId: string;
  /** 1-based attempt counter for retries. */
  attempt: number;
  agentType: string;
  prompt: string;
  model?: string;
  effort?: string;
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
 * unverified — the node actor checks for the capability before spawning.
 */
export interface NodeHost {
  spawnAgent(request: NodeSpawnRequest, signal: AbortSignal): Promise<NodeSpawnResult>;
  runGate?(command: string, options: { cwd?: string; signal: AbortSignal }): Promise<NodeGateResult>;
  /**
   * Await a human decision for a `human_gate` node. The result's `output` is the
   * human-supplied value (JSON when a schema is set). A host without this fails a
   * human_gate loudly rather than passing it unattended.
   */
  awaitHumanGate?(request: HumanGateRequest, signal: AbortSignal): Promise<NodeSpawnResult>;
}
