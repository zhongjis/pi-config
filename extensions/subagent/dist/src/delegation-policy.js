function buildCanonicalTypeMap(availableTypes) {
    return new Map(availableTypes.map((type) => [type.toLowerCase(), type]));
}
function dedupeTypes(types) {
    const seen = new Set();
    const deduped = [];
    for (const type of types) {
        const key = type.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(type);
    }
    return deduped;
}
function resolveCanonicalType(name, canonicalTypes) {
    return canonicalTypes.get(name.trim().toLowerCase());
}
export function hasDelegationPolicy(policy) {
    return Boolean(policy.allowDelegationTo?.length || policy.disallowDelegationTo?.length);
}
export function getPermittedDelegationTypes(policy, availableTypes) {
    const canonicalTypes = buildCanonicalTypeMap(availableTypes);
    const allowlisted = policy.allowDelegationTo?.length
        ? dedupeTypes(policy.allowDelegationTo
            .map((type) => resolveCanonicalType(type, canonicalTypes))
            .filter((type) => type != null))
        : [...availableTypes];
    if (!policy.disallowDelegationTo?.length) {
        return allowlisted;
    }
    const disallowed = new Set(policy.disallowDelegationTo
        .map((type) => resolveCanonicalType(type, canonicalTypes)?.toLowerCase())
        .filter((type) => type != null));
    return allowlisted.filter((type) => !disallowed.has(type.toLowerCase()));
}
export function resolveDelegationRequest(policy, requestedType, availableTypes) {
    const canonicalTypes = buildCanonicalTypeMap(availableTypes);
    const canonicalRequestedType = resolveCanonicalType(requestedType, canonicalTypes) ?? requestedType;
    const permittedTypes = getPermittedDelegationTypes(policy, availableTypes);
    const allowed = permittedTypes.some((type) => type.toLowerCase() === canonicalRequestedType.toLowerCase());
    return {
        allowed,
        requestedType: canonicalRequestedType,
        permittedTypes,
    };
}
export function buildDelegationBlockedMessage(delegatorType, requestedType, resolvedType, permittedTypes) {
    const requestedLabel = requestedType === resolvedType
        ? `"${requestedType}"`
        : `"${requestedType}" (resolved to "${resolvedType}")`;
    if (permittedTypes.length === 0) {
        return `Agent "${delegatorType}" cannot delegate to ${requestedLabel}. No delegation targets are permitted by its frontmatter policy.`;
    }
    return `Agent "${delegatorType}" cannot delegate to ${requestedLabel}. Allowed targets: ${permittedTypes.join(", ")}.`;
}
export function getCurrentDelegatorType(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "custom" || entry.customType !== "agent-mode")
            continue;
        if (typeof entry.data?.mode === "string" && entry.data.mode.trim()) {
            return entry.data.mode;
        }
    }
    return undefined;
}
