import { normalizeThinkingLevel } from "./thinking-level.js";
import { parseModelChain, type ModelCandidate } from "./model-resolver.js";

import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelCandidates: ModelCandidate[];
  modelFromParams: boolean;
  thinkingOverride?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  const rawModel = agentConfig?.model ?? params.model;
  const modelFromParams = agentConfig?.model == null && params.model != null;
  const modelCandidates = rawModel ? parseModelChain(rawModel) : [];
  const thinkingOverride = normalizeThinkingLevel(params.thinking);

  return {
    modelCandidates,
    modelFromParams,
    thinkingOverride,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation: agentConfig?.isolation ?? params.isolation,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
