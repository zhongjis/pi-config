import type { Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, parseModelChain, resolveFirstAvailable } from "../../lib/model-selection.js";
import type { ThinkingLevel } from "../../lib/thinking-level.js";

/** Resolve configuration once; availability fallback never retries execution. */
export function resolveAgentModel(
  input: string | undefined,
  registry: ModelRegistry,
  parent?: Model<string>,
): { model: Model<string> | undefined; thinkingLevel?: ThinkingLevel } {
  if (input == null) return { model: parent };
  const selected = resolveFirstAvailable(parseModelChain(input), registry);
  if (!selected) throw new Error(`Model not found: No available model in configured chain "${input}".`);
  return selected;
}
