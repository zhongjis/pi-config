export interface DelegationPolicy {
	allowDelegationTo?: string[];
	disallowDelegationTo?: string[];
}

export interface ModeStateEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface VersionedDelegationPolicyV1 {
	version: 1;
	allowDelegationTo: string[];
	disallowDelegationTo: string[];
}

function buildCanonicalTypeMap(availableTypes: string[]): Map<string, string> {
	return new Map(availableTypes.map((type) => [type.toLowerCase(), type]));
}

function dedupeTypes(types: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const type of types) {
		const key = type.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(type);
	}
	return deduped;
}

function resolveCanonicalType(
	name: string,
	canonicalTypes: Map<string, string>,
): string | undefined {
	return canonicalTypes.get(name.trim().toLowerCase());
}

export function hasDelegationPolicy(policy: DelegationPolicy): boolean {
	return Boolean(
		policy.allowDelegationTo?.length || policy.disallowDelegationTo?.length,
	);
}

export function getPermittedDelegationTypes(
	policy: DelegationPolicy,
	availableTypes: string[],
): string[] {
	const canonicalTypes = buildCanonicalTypeMap(availableTypes);
	const allowlisted = policy.allowDelegationTo?.length
		? dedupeTypes(
				policy.allowDelegationTo
					.map((type) => resolveCanonicalType(type, canonicalTypes))
					.filter((type): type is string => type != null),
			)
		: [...availableTypes];

	if (!policy.disallowDelegationTo?.length) {
		return allowlisted;
	}

	const disallowed = new Set(
		policy.disallowDelegationTo
			.map((type) => resolveCanonicalType(type, canonicalTypes)?.toLowerCase())
			.filter((type): type is string => type != null),
	);

	return allowlisted.filter((type) => !disallowed.has(type.toLowerCase()));
}

export function resolveDelegationRequest(
	policy: DelegationPolicy,
	requestedType: string,
	availableTypes: string[],
): {
	allowed: boolean;
	requestedType: string;
	permittedTypes: string[];
} {
	const canonicalTypes = buildCanonicalTypeMap(availableTypes);
	const canonicalRequestedType =
		resolveCanonicalType(requestedType, canonicalTypes) ?? requestedType;
	const permittedTypes = getPermittedDelegationTypes(policy, availableTypes);
	const allowed = permittedTypes.some(
		(type) => type.toLowerCase() === canonicalRequestedType.toLowerCase(),
	);

	return {
		allowed,
		requestedType: canonicalRequestedType,
		permittedTypes,
	};
}

export const DELEGATION_POLICY_DENIED = "delegation_policy_denied" as const;

export interface ResolvedDelegationPolicy {
	status: "unrestricted" | "resolved" | "unresolved";
	activeMode: string | undefined;
	permittedTypes: string[];
	decision: {
		allowed: boolean;
		category: typeof DELEGATION_POLICY_DENIED | undefined;
		requestedType: string;
	};
}

/** Pure session-policy resolver. An identified mode without an explicit policy fails closed. */
export function resolveDelegationPolicy(input: {
	activeMode: string | undefined;
	policy?: DelegationPolicy;
	availableTypes: string[];
	requestedType: string;
}): ResolvedDelegationPolicy {
	const { activeMode, policy, availableTypes, requestedType } = input;
	if (!activeMode) {
		const requested =
			resolveCanonicalType(requestedType, buildCanonicalTypeMap(availableTypes)) ??
			requestedType;
		return {
			status: "unrestricted",
			activeMode: undefined,
			permittedTypes: [...availableTypes],
			decision: { allowed: true, category: undefined, requestedType: requested },
		};
	}

	if (!policy || !hasDelegationPolicy(policy)) {
		return {
			status: "unresolved",
			activeMode,
			permittedTypes: [],
			decision: {
				allowed: false,
				category: DELEGATION_POLICY_DENIED,
				requestedType,
			},
		};
	}

	const resolved = resolveDelegationRequest(policy, requestedType, availableTypes);
	return {
		status: "resolved",
		activeMode,
		permittedTypes: resolved.permittedTypes,
		decision: {
			allowed: resolved.allowed,
			category: resolved.allowed ? undefined : DELEGATION_POLICY_DENIED,
			requestedType: resolved.requestedType,
		},
	};
}

function unresolvedDelegationPolicy(
	activeMode: string | undefined,
	requestedType: string,
): ResolvedDelegationPolicy {
	return {
		status: "unresolved",
		activeMode,
		permittedTypes: [],
		decision: {
			allowed: false,
			category: DELEGATION_POLICY_DENIED,
			requestedType,
		},
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parsePersistedModeState(data: unknown): {
	activeMode: string;
	policy: VersionedDelegationPolicyV1;
} | undefined {
	if (!data || typeof data !== "object") return undefined;
	const state = data as Record<string, unknown>;
	if (typeof state.mode !== "string" || !state.mode.trim()) return undefined;
	if (!state.delegationPolicy || typeof state.delegationPolicy !== "object") return undefined;
	const policy = state.delegationPolicy as Record<string, unknown>;
	if (policy.version !== 1 || !isStringArray(policy.allowDelegationTo) || !isStringArray(policy.disallowDelegationTo)) {
		return undefined;
	}
	return {
		activeMode: state.mode,
		policy: {
			version: 1,
			allowDelegationTo: policy.allowDelegationTo,
			disallowDelegationTo: policy.disallowDelegationTo,
		},
	};
}

/** Resolve delegation authority from the latest persisted agent-mode entry only. */
export function resolvePersistedDelegationPolicy(input: {
	entries: readonly ModeStateEntryLike[];
	availableTypes: string[];
	requestedType: string;
}): ResolvedDelegationPolicy {
	const latestEntry = [...input.entries].reverse().find(
		(entry) => entry.type === "custom" && entry.customType === "agent-mode",
	);
	if (!latestEntry) {
		return resolveDelegationPolicy({
			activeMode: undefined,
			availableTypes: input.availableTypes,
			requestedType: input.requestedType,
		});
	}

	const persisted = parsePersistedModeState(latestEntry.data);
	if (!persisted) {
		const data = latestEntry.data && typeof latestEntry.data === "object"
			? latestEntry.data as Record<string, unknown>
			: undefined;
		const activeMode = typeof data?.mode === "string" && data.mode.trim() ? data.mode : undefined;
		return unresolvedDelegationPolicy(activeMode, input.requestedType);
	}

	return resolveDelegationPolicy({
		activeMode: persisted.activeMode,
		policy: persisted.policy,
		availableTypes: input.availableTypes,
		requestedType: input.requestedType,
	});
}

export function formatDelegationPolicyDenial(
	policy: ResolvedDelegationPolicy,
	requestedType: string,
): string {
	const mode = policy.activeMode ?? "unknown";
	if (policy.status === "unresolved") {
		return `${DELEGATION_POLICY_DENIED}: Active mode "${mode}" delegation policy is unavailable. No delegation targets are permitted.`;
	}
	return `${DELEGATION_POLICY_DENIED}: ${buildDelegationBlockedMessage(mode, requestedType, policy.decision.requestedType, policy.permittedTypes)}`;
}

export function buildDelegationBlockedMessage(
	delegatorType: string,
	requestedType: string,
	resolvedType: string,
	permittedTypes: string[],
): string {
	const requestedLabel =
		requestedType === resolvedType
			? `"${requestedType}"`
			: `"${requestedType}" (resolved to "${resolvedType}")`;

	if (permittedTypes.length === 0) {
		return `Agent "${delegatorType}" cannot delegate to ${requestedLabel}. No delegation targets are permitted by its frontmatter policy.`;
	}

	return `Agent "${delegatorType}" cannot delegate to ${requestedLabel}. Allowed targets: ${permittedTypes.join(", ")}.`;
}

export function getCurrentDelegatorType(
	entries: ModeStateEntryLike[],
): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== "agent-mode") continue;
		if (!entry.data || typeof entry.data !== "object") return undefined;
		const mode = (entry.data as Record<string, unknown>).mode;
		return typeof mode === "string" && mode.trim() ? mode : undefined;
	}

	return undefined;
}
