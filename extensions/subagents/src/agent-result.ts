import type { AgentRecord } from "./types.js";
import { type AgentActivity, type AgentDetails, buildInvocationTags, describeActivity, formatTokens, getPromptModeLabel } from "./ui/agent-widget.js";
import { getLifetimeTotal, type LifetimeUsage } from "./usage.js";

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/** Salvaged output is bounded to the failed run's own turns, not an earlier answer. */
export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}

interface ResultSnapshot {
  readonly activity?: AgentActivity;
  readonly overrides?: Partial<AgentDetails>;
}

/** Shared foreground, retrieval, and resume report semantics. */
export function createAgentResultBuilder(showCost: () => boolean) {
  return function buildDetails(
    base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
    record: AgentRecord,
    snapshot: ResultSnapshot = {},
  ): AgentDetails {
    const { activity, overrides } = snapshot;
    const invocation = {
      ...record.invocation,
      modelName: record.session?.model ? `${record.session.model.provider}/${record.session.model.id}` : undefined,
      thinking: record.session?.thinkingLevel,
      thinkingDefault: !record.session && record.invocation?.thinkingDefault,
    };
    return {
      ...base,
      ...buildInvocationTags(invocation),
      tags: [...new Set([
        ...(base.tags ?? []).filter((tag) => !tag.startsWith("thinking:")),
        ...[getPromptModeLabel(base.subagentType)].filter((tag): tag is string => Boolean(tag)),
        ...buildInvocationTags(invocation).tags,
      ])],
      thinking: invocation.thinking,
      ...(record.session && invocation.requestedModel !== undefined && invocation.requestedModel !== invocation.modelName
        ? { requestedModel: invocation.requestedModel } : {}),
      ...(record.session && invocation.requestedThinking !== undefined && invocation.requestedThinking !== invocation.thinking
        ? { requestedThinking: invocation.requestedThinking } : {}),
      ...(showCost() ? { cost: record.lifetimeCost ?? 0 } : {}),
      result: record.result ?? "",
      outputFile: record.outputFile,
      diagnostics: record.diagnostics ? [...record.diagnostics] : undefined,
      delivery: record.isBackground ? "background" : "foreground",
      toolUses: record.toolUses,
      tokens: formatLifetimeTokens(record),
      turnCount: record.turnCount ?? activity?.turnCount,
      maxTurns: record.maxTurns ?? activity?.maxTurns,
      durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
      status: record.status as AgentDetails["status"],
      agentId: record.id,
      activity: activity ? describeActivity(activity.activeTools, activity.responseText) : undefined,
      error: record.error,
      ...overrides,
    };
  };
}
