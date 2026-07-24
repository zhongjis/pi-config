import type { ToolDescriptionMode } from "./settings.js";

/** Full Agent tool description. */
function fullDescription(typeListText: string): string {
  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
- run_in_background controls when Agent returns; the agent type's configured run_in_background takes precedence over this call. Effective false waits for completion and returns the final result. Effective true returns an agent ID immediately for supervision with get_subagent_result and steer_subagent.
- run_in_background does not control sibling tool scheduling. In Pi's default parallel tool mode, sibling Agent calls from one assistant response execute concurrently; sequential tool mode runs them one at a time. Background runs may queue at the configured concurrency limit; foreground runs bypass that queue.
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

Notes: run_in_background controls return timing, not sibling scheduling; agent-type configuration overrides the call, defaulting to false. Effective false waits for the final result; effective true returns an agent ID immediately. Pi's default parallel tool mode can overlap sibling calls; sequential mode cannot. Background runs may queue; foreground runs bypass that queue. Supervise background agents with get_subagent_result / steer_subagent. Resume only the same workstream (follow-up, correction, recheck); start fresh for independent/unrelated work; on resume failure, report it and do not auto-fallback to fresh. Optional params: model ("provider/modelId" or fuzzy), thinking, max_turns, isolated, inherit_context, skills (per-call skill injection; subagents cannot discover skills on their own).`;
}

export function buildAgentToolDescription(
  mode: ToolDescriptionMode,
  typeListText: string,
  compactTypeListText: string,
): string {
  return mode === "compact" ? compactDescription(compactTypeListText) : fullDescription(typeListText);
}
