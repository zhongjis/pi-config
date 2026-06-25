import type { ToolDescriptionMode } from "./settings.js";

/** Full Claude-Code-style description — byte-identical to the pre-feature inline literal. */
function fullDescription(typeListText: string): string {
  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.
- Leave max_turns unset unless you need an explicit cap. Unset is the normal unlimited-by-default behavior.
- Background agents require active supervision: check progress with get_subagent_result, use steer_subagent for mid-run course correction, and use resume to continue the same agent instead of starting duplicate work.
- If a background agent is still useful, keep supervising it rather than launching overlapping duplicate work or leaving it unattended for long periods.
- Choose an available custom agent whose description matches the task.
- Provide clear, detailed prompts so the agent can work autonomously.
- Agent results are returned as text; summarize them for the user.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.`;
}

/** ~75% smaller: terse intro, first-sentence-only agent list, one notes line. */
function compactDescription(compactTypeListText: string): string {
  return `Launch a specialized agent to handle a complex task autonomously.

Available agent types:
${compactTypeListText}

Notes: run_in_background:true runs in parallel — supervise with get_subagent_result / steer_subagent / resume. Optional params: model ("provider/modelId" or fuzzy), thinking, max_turns, isolated, inherit_context.`;
}

export function buildAgentToolDescription(
  mode: ToolDescriptionMode,
  typeListText: string,
  compactTypeListText: string,
): string {
  return mode === "compact" ? compactDescription(compactTypeListText) : fullDescription(typeListText);
}
