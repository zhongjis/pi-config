import { normalizeThinkingLevel } from "./thinking-level.js";
export function resolveAgentInvocationConfig(agentConfig, params) {
    return {
        modelInput: agentConfig?.model ?? params.model,
        modelFromParams: agentConfig?.model == null && params.model != null,
        thinking: normalizeThinkingLevel(agentConfig?.thinking ?? params.thinking),
        maxTurns: agentConfig?.maxTurns ?? params.max_turns,
        inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
        runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
        isolated: agentConfig?.isolated ?? params.isolated ?? false,
        isolation: agentConfig?.isolation ?? params.isolation,
    };
}
export function resolveJoinMode(defaultJoinMode, runInBackground) {
    return runInBackground ? defaultJoinMode : undefined;
}
