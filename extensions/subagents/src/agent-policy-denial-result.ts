import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface AgentToolResultEvent {
  toolName?: unknown;
  content?: unknown;
  details?: unknown;
  isError?: unknown;
}

function isPolicyDenialDetails(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const value = details as Record<string, unknown>;
  return value.category === "delegation_policy_denied" && value.invocationStatus === "failed";
}

export function registerAgentPolicyDenialResultHook(pi: Pick<ExtensionAPI, "on">): void {
  pi.on("tool_result", (rawEvent) => {
    const event = rawEvent as AgentToolResultEvent | null;
    if (
      !event ||
      event.toolName !== "Agent" ||
      event.isError === true ||
      !Array.isArray(event.content) ||
      !isPolicyDenialDetails(event.details)
    ) {
      return undefined;
    }
    return { isError: true };
  });
}
