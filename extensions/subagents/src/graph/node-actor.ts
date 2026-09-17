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
 * Deterministic gate validation and the retry/repair lifecycle are layered on in
 * a later phase; this actor owns the spawn and the schema re-check.
 */

import { fromPromise } from "xstate";
import type { CompiledSchema } from "./json-schema.js";
import type { NodeHost, NodeSpawnRequest, NodeSpawnResult } from "./node-host.js";

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

export type { NodeSpawnRequest };
