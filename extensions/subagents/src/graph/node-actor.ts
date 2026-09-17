/**
 * node-actor.ts — one agent node as XState promise-actor logic.
 *
 * `fromPromise` gives the node its lifecycle for free: the actor is active while
 * the spawn is pending and settles `done`, and `actor.stop()` aborts the `signal`
 * XState hands the creator (xstate v5.19+). The host forwards that signal to the
 * child, so cancelling the run cancels the model call.
 *
 * The promise settles with a {@link NodeSpawnResult} for both success and failure
 * rather than throwing on a failed agent: the scheduler inspects `result.ok`, and
 * a rejected promise would collapse that distinction into an actor error. A schema
 * mismatch is a node failure, so it comes back the same way — as `ok: false`.
 *
 * `agentNodeLogic` is the single-attempt primitive (spawn + schema re-check).
 * `nodeLogic` is the full node-completion lifecycle used by the runner: spawn ->
 * schema -> gate, retried up to maxAttempts on validation failure.
 */

import { fromPromise } from "xstate";
import type { CompiledSchema } from "./json-schema.js";
import type { NodeHost, NodeResolvedInfo, NodeSpawnRequest, NodeSpawnResult } from "./node-host.js";

export interface AgentNodeInput {
  host: NodeHost;
  request: NodeSpawnRequest;
}

/**
 * Re-check a schema'd result host-side.
 *
 * The child's own `StructuredOutput` tool already validated whatever it passed,
 * so this normally agrees; it exists for the cases where nothing did (a host that
 * ignores `schema`, a hand-edited replay). The script runtime made the same
 * belt-and-braces check for the same reason.
 */
export function checkNodeSchema(result: NodeSpawnResult, schema: CompiledSchema): NodeSpawnResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output ?? "");
  } catch {
    return { ...result, ok: false, error: "The agent did not return structured output: its answer was not JSON." };
  }
  const verdict = schema.check(parsed);
  if (verdict === true) return result;
  return { ...result, ok: false, error: `The agent's answer did not match the requested schema: ${verdict}` };
}

export const agentNodeLogic = fromPromise<NodeSpawnResult, AgentNodeInput>(async ({ input, signal }) => {
  const result = await input.host.spawnAgent(input.request, signal);
  if (!result.ok) return result;
  const schema = input.request.schema;
  return schema === undefined ? result : checkNodeSchema(result, schema);
});

export interface NodeExecInput {
  host: NodeHost;
  nodeId: string;
  agentType: string;
  prompt: string;
  schema?: CompiledSchema;
  onResolved?(info: NodeResolvedInfo): void;
  /** Deterministic gate command run after a successful, schema-valid spawn. */
  gate?: string;
  /** Total attempts including the first; >1 retries on validation failure. */
  maxAttempts?: number;
}

/**
 * The full node-completion lifecycle as one XState actor: spawn -> schema -> gate,
 * retried up to `maxAttempts` on validation failure.
 *
 * Retry here is node-internal (a validation failure re-runs the same node); it is
 * distinct from a scheduler loop, which re-enters a node across a cycle. One actor
 * spans every attempt, so `actor.stop()` aborts whichever spawn is in flight. A
 * user skip stops retrying immediately; a requested gate with no `runGate` fails
 * loudly rather than passing unverified work.
 */
export const nodeLogic = fromPromise<NodeSpawnResult, NodeExecInput>(async ({ input, signal }) => {
  const attempts = Math.max(1, input.maxAttempts ?? 1);
  let last: NodeSpawnResult = { ok: false, error: "node did not run" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal.aborted) return { ok: false, skipped: true, error: "Aborted." };
    const request: NodeSpawnRequest = { nodeId: input.nodeId, attempt, agentType: input.agentType, prompt: input.prompt };
    if (input.onResolved !== undefined) request.onResolved = input.onResolved;
    if (input.schema !== undefined) request.schema = input.schema;
    let result = await input.host.spawnAgent(request, signal);
    if (result.ok && input.schema !== undefined) result = checkNodeSchema(result, input.schema);
    if (result.ok && input.gate !== undefined) {
      if (input.host.runGate === undefined) {
        return { ...result, ok: false, error: "This host cannot run gate commands." };
      }
      const gate = await input.host.runGate(input.gate, { cwd: result.cwd, signal });
      if (!gate.ok) result = { ...result, ok: false, error: gate.output.trim() || `Gate command failed: ${input.gate}` };
    }
    if (result.ok) return result;
    last = result;
    if (result.skipped) return result; // user skip: do not retry
  }
  return last;
});

export type { NodeSpawnRequest };
