import type { ToolDescriptionMode } from "./settings.js";

/** Full Agent tool description. */
function fullDescription(typeListText: string): string {
  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
- run_in_background: false waits for completion; true returns an agent ID immediately. This flag controls result delivery, not serialization: Agent calls dispatched concurrently can overlap in either mode.
- Leave max_turns unset unless you need an explicit cap. Unset is the normal unlimited-by-default behavior.
- Use resume only for the same workstream: a follow-up, correction, or recheck. Start a fresh agent for independent or unrelated work. If resume fails, report the failure; do not automatically fall back to a fresh call.
- Background agents require active supervision: check progress with get_subagent_result, use steer_subagent for mid-run course correction, and use resume only as described above to continue the same agent instead of starting duplicate work.
- If a background agent is still useful, keep supervising it rather than launching overlapping duplicate work or leaving it unattended for long periods.
- Choose an available custom agent whose description matches the task.
- Provide clear, detailed prompts so the agent can work autonomously.
- Agent results are returned as text; summarize them for the user.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use skills to inject named skills (full content) into the subagent for this call; subagents cannot discover skills themselves, so pass any skill the task requires.`;
}

/** ~75% smaller: terse intro, first-sentence-only agent list, one notes line. */
function compactDescription(compactTypeListText: string): string {
  return `Launch a specialized agent to handle a complex task autonomously.

Available agent types:
${compactTypeListText}

Notes: run_in_background:false waits for completion; true returns an agent ID immediately. It controls result delivery, not serialization: concurrently dispatched Agent calls can overlap in either mode. Supervise background agents with get_subagent_result / steer_subagent. Resume only the same workstream (follow-up, correction, recheck); start fresh for independent/unrelated work; on resume failure, report it and do not auto-fallback to fresh. Optional params: model ("provider/modelId" or fuzzy), thinking, max_turns, isolated, inherit_context, skills (per-call skill injection; subagents cannot discover skills on their own).`;
}

export function buildAgentToolDescription(
  mode: ToolDescriptionMode,
  typeListText: string,
  compactTypeListText: string,
): string {
  return mode === "compact" ? compactDescription(compactTypeListText) : fullDescription(typeListText);
}
