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
export declare function resolveAgentInvocationConfig(agentConfig: AgentConfig | undefined, params: AgentInvocationParams): {
    modelInput?: string;
    modelFromParams: boolean;
    thinking?: ThinkingLevel;
    maxTurns?: number;
    inheritContext: boolean;
    runInBackground: boolean;
    isolated: boolean;
    isolation?: IsolationMode;
};
export declare function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined;
export {};
