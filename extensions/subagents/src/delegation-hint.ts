import type { ResolvedDelegationPolicyContext } from "./delegation-policy.js";

export const DELEGATION_POLICY_HINT_START = "<!-- subagents:delegation-policy -->";
export const DELEGATION_POLICY_HINT_END = "<!-- /subagents:delegation-policy -->";

const delegationHintBlock = /(?:\n\n)?<!-- subagents:delegation-policy -->[\s\S]*?<!-- \/subagents:delegation-policy -->/g;

export function renderDelegationPolicyHint(policy: ResolvedDelegationPolicyContext): string {
  const targetNames = policy.permittedTypes.length > 0 ? policy.permittedTypes.join(", ") : "none";
  const policyLabel = policy.activeMode
    ? `Current mode ${policy.activeMode} permitted delegation targets:`
    : "Current permitted delegation targets:";
  return `${DELEGATION_POLICY_HINT_START}\n${policyLabel} ${targetNames}\n${DELEGATION_POLICY_HINT_END}`;
}

/** Replace this extension's hint without disturbing other prompt transforms. */
export function replaceDelegationPolicyHint(
  systemPrompt: string,
  policy: ResolvedDelegationPolicyContext,
): string {
  const withoutOwnHint = systemPrompt.replace(delegationHintBlock, "").trimEnd();
  const hint = renderDelegationPolicyHint(policy);
  return withoutOwnHint ? `${withoutOwnHint}\n\n${hint}` : hint;
}
