import type { Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, parseModelChain, resolveFirstAvailable } from "../../lib/model-selection.js";
import type { ThinkingLevel } from "../../lib/thinking-level.js";
import { assertFastSupported } from "../../lib/fast.js";

export interface SelectedAgentModel {
  model: Model<string> | undefined;
  thinkingLevel?: ThinkingLevel;
  fast?: boolean;
  /** Effective invocation spec; lets the runner retain the chosen fallback. */
  modelInput?: string;
}

/** Resolve configuration once; availability fallback never retries execution. */
export function resolveAgentModel(
  input: string | undefined,
  registry: ModelRegistry & { isUsingOAuth?: (model: Model<string>) => boolean },
  parent?: Model<string>,
): SelectedAgentModel {
  if (input == null) return { model: parent };
  const selected = resolveFirstAvailable(parseModelChain(input), registry);
  if (!selected) throw new Error(`Model not found: No available model in configured chain "${input}".`);
  if (selected.fast) assertFastSupported(selected.model, registry.isUsingOAuth?.(selected.model) ?? false);
  return selected;
}
