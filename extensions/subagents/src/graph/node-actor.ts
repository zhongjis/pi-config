import type { CompiledSchema } from "./json-schema.js";
import type { NodeSpawnResult } from "./node-host.js";

/** Re-check host output at the typed node schema boundary. */
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
