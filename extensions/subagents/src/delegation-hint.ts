import type { ResolvedDelegationPolicyContext } from "./delegation-policy.js";

export function renderDelegationPolicyHint(policy: ResolvedDelegationPolicyContext): string {
  const targetNames = policy.permittedTypes.length > 0 ? policy.permittedTypes.join(", ") : "none";
  const policyLabel = policy.activeMode
    ? `Current mode ${policy.activeMode} permitted delegation targets:`
    : "Current permitted delegation targets:";
  return `${policyLabel} ${targetNames}`;
}
