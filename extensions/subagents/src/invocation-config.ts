import { getAgentConfig } from "./agent-types.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { resolveAgentModel } from "./model-resolution.js";
import { normalizeThinkingLevel } from "./thinking-level.js";
import type { AgentConfig, JoinMode, ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  selectedThinking?: string,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: normalizeThinkingLevel(agentConfig?.thinking ?? selectedThinking ?? params.thinking),
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
  };
}

export interface PrepareAgentInvocationOptions {
  agentType: string;
  params: AgentInvocationParams;
  modelRegistry: Parameters<typeof resolveAgentModel>[1];
  parentModel: Parameters<typeof resolveAgentModel>[2];
  cwd: string;
  scopeModels: boolean;
}

export interface PreparedAgentInvocation {
  agentConfig: AgentConfig | undefined;
  invocation: ReturnType<typeof resolveAgentInvocationConfig>;
  selectedModel: ReturnType<typeof resolveAgentModel>;
  scope?: {
    allowed: Set<string>;
    model: NonNullable<ReturnType<typeof resolveAgentModel>["model"]>;
  };
}

export function prepareAgentInvocation({
  agentType,
  params,
  modelRegistry,
  parentModel,
  cwd,
  scopeModels,
}: PrepareAgentInvocationOptions): PreparedAgentInvocation {
  const agentConfig = getAgentConfig(agentType);
  const initial = resolveAgentInvocationConfig(agentConfig, params);
  const selected = resolveAgentModel(initial.modelInput, modelRegistry, parentModel);
  const invocation = resolveAgentInvocationConfig(agentConfig, params, selected.thinkingLevel);
  const selectedModel = { ...selected, modelInput: invocation.modelInput, invocationThinkingLevel: normalizeThinkingLevel(params.thinking) };
  const allowed = scopeModels && selectedModel.model
    ? resolveEnabledModels(readEnabledModels(cwd), modelRegistry, cwd)
    : undefined;
  const scope = allowed && selectedModel.model && !isModelInScope(selectedModel.model, allowed)
    ? { allowed, model: selectedModel.model }
    : undefined;
  return { agentConfig, invocation, selectedModel, scope };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
