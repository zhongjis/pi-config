import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATION_POLICY_DENIED, type ResolvedDelegationPolicy } from "./delegation-policy.js";
import { type AgentDetails, getDisplayName } from "./ui/agent-widget.js";

interface AgentPolicyDenialDetails extends AgentDetails {
  readonly invocationStatus: "failed";
  readonly category: typeof DELEGATION_POLICY_DENIED;
  readonly activeMode: string | undefined;
  readonly requestedType: string;
  readonly permittedTypes: string[];
}

export function buildAgentPolicyDenialDetails(
  policy: ResolvedDelegationPolicy,
  requestedType: string,
  description: string,
): AgentPolicyDenialDetails {
  return {
    displayName: getDisplayName(requestedType),
    description,
    subagentType: requestedType,
    toolUses: 0,
    tokens: "",
    durationMs: 0,
    status: "error",
    invocationStatus: "failed",
    category: DELEGATION_POLICY_DENIED,
    activeMode: policy.activeMode,
    requestedType: policy.decision.requestedType,
    permittedTypes: [...policy.permittedTypes],
  };
}

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
      event?.toolName !== "Agent" ||
      event.isError === true ||
      !Array.isArray(event.content) ||
      !isPolicyDenialDetails(event.details)
    ) {
      return undefined;
    }
    return { isError: true };
  });
}
