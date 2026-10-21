import { type AccessRule, BUILTIN_TOOL_NAMES, parseAccessRules, resolveToolAccess } from "../../lib/active-tools.js";
import type { AgentConfig } from "./types.js";

export interface DelegationPolicy {
	readonly rules: AccessRule[];
}

export interface ModeStateEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface VersionedDelegationPolicyV2 extends DelegationPolicy {
	version: 2;
}

function buildCanonicalTypeMap(availableTypes: string[]): Map<string, string> {
	return new Map(availableTypes.map((type) => [type.toLowerCase(), type]));
}

function resolveCanonicalType(
	name: string,
	canonicalTypes: Map<string, string>,
): string | undefined {
	return canonicalTypes.get(name.trim().toLowerCase());
}

export function hasDelegationPolicy(policy: DelegationPolicy): boolean {
	return policy.rules.some((rule) => rule.sign === "+");
}

export function getPermittedDelegationTypes(
	policy: DelegationPolicy,
	availableTypes: string[],
): string[] {
	const canonicalTypes = buildCanonicalTypeMap(availableTypes);
	const permitted = new Set<string>();
	for (const rule of policy.rules) {
		const selector = rule.selector.toLowerCase();
		const targets = selector === "@all"
			? [...canonicalTypes.values()]
			: [resolveCanonicalType(selector, canonicalTypes)];
		for (const target of targets) {
			if (target === undefined) continue;
			if (rule.sign === "+") permitted.add(target);
			else permitted.delete(target);
		}
	}
	return [...permitted];
}

const MUTATING_BUILTIN_TOOLS = ["edit", "write", "powershell"];

/** Resolve signed delegation rules, retaining only enabled, read-only leaves. */
export function resolveNestedTargets(
	parent: Pick<AgentConfig, "name" | "allowNesting" | "delegationRules">,
	configs: readonly AgentConfig[],
	isGuardedBash: (type: string) => boolean,
): string[] {
	if (parent.allowNesting !== true) return [];
	const byName = new Map(configs.map((config) => [config.name.toLowerCase(), config]));
	const builtins = BUILTIN_TOOL_NAMES.map((name) => ({ name, extensionIds: [] }));
	return getPermittedDelegationTypes({ rules: parent.delegationRules ?? [] }, configs.map((config) => config.name)).filter((type) => {
		const target = byName.get(type.toLowerCase());
		if (!target || target.enabled === false || target.allowNesting === true || target.promptMode === "append") return false;
		if (type.toLowerCase() === parent.name.toLowerCase()) return false;
		const granted = resolveToolAccess(target.toolRules, builtins).allowed;
		if (MUTATING_BUILTIN_TOOLS.some((name) => granted.has(name))) return false;
		return !granted.has("bash") || isGuardedBash(type);
	});
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

export interface ResolvedDelegationPolicyContext {
	status: "unrestricted" | "resolved" | "unresolved";
	activeMode: string | undefined;
	permittedTypes: string[];
}

export interface ResolvedDelegationPolicy extends ResolvedDelegationPolicyContext {
	decision: {
		allowed: boolean;
		category: typeof DELEGATION_POLICY_DENIED | undefined;
		requestedType: string;
	};
}

function resolveDelegationPolicyContext(input: {
	activeMode: string | undefined;
	policy?: DelegationPolicy;
	availableTypes: string[];
}): ResolvedDelegationPolicyContext {
	const { activeMode, policy, availableTypes } = input;
	if (!activeMode) {
		return { status: "unrestricted", activeMode: undefined, permittedTypes: [...availableTypes] };
	}
	if (!policy || !hasDelegationPolicy(policy)) {
		return { status: "unresolved", activeMode, permittedTypes: [] };
	}
	return {
		status: "resolved",
		activeMode,
		permittedTypes: getPermittedDelegationTypes(policy, availableTypes),
	};
}

function resolveDelegationDecision(
	context: ResolvedDelegationPolicyContext,
	requestedType: string,
	availableTypes: string[],
): ResolvedDelegationPolicy {
	const canonicalRequestedType =
		resolveCanonicalType(requestedType, buildCanonicalTypeMap(availableTypes)) ?? requestedType;
	const allowed = context.status === "unrestricted" || context.permittedTypes.some(
		(type) => type.toLowerCase() === canonicalRequestedType.toLowerCase(),
	);
	return {
		...context,
		decision: {
			allowed,
			category: allowed ? undefined : DELEGATION_POLICY_DENIED,
			requestedType: canonicalRequestedType,
		},
	};
}

/** Pure session-policy resolver. An identified mode without an explicit policy fails closed. */
export function resolveDelegationPolicy(input: {
	activeMode: string | undefined;
	policy?: DelegationPolicy;
	availableTypes: string[];
	requestedType: string;
}): ResolvedDelegationPolicy {
	return resolveDelegationDecision(
		resolveDelegationPolicyContext(input),
		input.requestedType,
		input.availableTypes,
	);
}

function parsePersistedModeState(data: unknown): {
	activeMode: string;
	policy: VersionedDelegationPolicyV2;
} | undefined {
	if (!data || typeof data !== "object") return undefined;
	const state = data as Record<string, unknown>;
	if (typeof state.mode !== "string" || !state.mode.trim()) return undefined;
	if (!state.delegationPolicy || typeof state.delegationPolicy !== "object") return undefined;
	const policy = state.delegationPolicy as Record<string, unknown>;
	if (policy.version !== 2 || !Array.isArray(policy.rules)) return undefined;
	const entries: string[] = [];
	for (const rule of policy.rules) {
		if (!rule || typeof rule !== "object" || !("sign" in rule) || !("selector" in rule)) return undefined;
		if ((rule.sign !== "+" && rule.sign !== "-") || typeof rule.selector !== "string") return undefined;
		entries.push(`${rule.sign}${rule.selector}`);
	}
	const parsed = parseAccessRules("delegation", entries);
	if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return undefined;
	return {
		activeMode: state.mode,
		policy: {
			version: 2,
			rules: parsed.rules,
		},
	};
}

/** Resolve current delegation authority from the latest persisted agent-mode entry only. */
export function resolvePersistedDelegationPolicyContext(input: {
	entries: readonly ModeStateEntryLike[];
	availableTypes: string[];
}): ResolvedDelegationPolicyContext {
	const latestEntry = [...input.entries].reverse().find(
		(entry) => entry.type === "custom" && entry.customType === "agent-mode",
	);
	if (!latestEntry) {
		return resolveDelegationPolicyContext({
			activeMode: undefined,
			availableTypes: input.availableTypes,
		});
	}

	const persisted = parsePersistedModeState(latestEntry.data);
	if (!persisted) {
		const data = latestEntry.data && typeof latestEntry.data === "object"
			? latestEntry.data as Record<string, unknown>
			: undefined;
		const activeMode = typeof data?.mode === "string" && data.mode.trim() ? data.mode : undefined;
		return { status: "unresolved", activeMode, permittedTypes: [] };
	}

	return resolveDelegationPolicyContext({
		activeMode: persisted.activeMode,
		policy: persisted.policy,
		availableTypes: input.availableTypes,
	});
}

/** Resolve a delegation request against the latest persisted mode policy. */
export function resolvePersistedDelegationPolicy(input: {
	entries: readonly ModeStateEntryLike[];
	availableTypes: string[];
	requestedType: string;
}): ResolvedDelegationPolicy {
	return resolveDelegationDecision(
		resolvePersistedDelegationPolicyContext(input),
		input.requestedType,
		input.availableTypes,
	);
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
