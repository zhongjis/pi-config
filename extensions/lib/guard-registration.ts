import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

export const SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY = "smart-tool-guards:bash" as const;

export type GuardCapability = typeof SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY;
export type GuardScopeDecision = "guard" | "abstain";
export type GuardScopeProvider = (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => GuardScopeDecision | Promise<GuardScopeDecision>;
export interface GuardScopeError {
	block: true;
	reason: string;
}
export type GuardScopeEvaluation = GuardScopeDecision | GuardScopeError;

const CAPABILITY_QUERY_CHANNEL = "smart-tool-guards:capability-query";
const SCOPE_QUERY_CHANNEL = "smart-tool-guards:scope-query";

interface CapabilityQuery {
	readonly capability: GuardCapability;
	acknowledged: boolean;
}

interface ScopeQuery {
	readonly providers: Map<string, GuardScopeProvider>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapabilityQuery(value: unknown, capability: GuardCapability): value is CapabilityQuery {
	return isRecord(value) && value.capability === capability && typeof value.acknowledged === "boolean";
}

function isScopeQuery(value: unknown): value is ScopeQuery {
	return isRecord(value) && value.providers instanceof Map;
}

export function registerGuardCapability(pi: ExtensionAPI, capability: GuardCapability): void {
	const unsubscribe = pi.events.on(CAPABILITY_QUERY_CHANNEL, (data: unknown) => {
		if (isCapabilityQuery(data, capability)) data.acknowledged = true;
	});
	pi.on("session_shutdown", unsubscribe);
}

export function hasGuardCapability(pi: ExtensionAPI, capability: GuardCapability): boolean {
	const query: CapabilityQuery = { capability, acknowledged: false };
	pi.events.emit(CAPABILITY_QUERY_CHANNEL, query);
	return query.acknowledged;
}

export function registerGuardScopeProvider(pi: ExtensionAPI, id: string, provider: GuardScopeProvider): void {
	if (!id.trim()) throw new Error("Guard scope provider ID must not be empty.");
	const unsubscribe = pi.events.on(SCOPE_QUERY_CHANNEL, (data: unknown) => {
		if (isScopeQuery(data)) data.providers.set(id, provider);
	});
	pi.on("session_shutdown", unsubscribe);
}

export async function evaluateGuardScope(
	pi: ExtensionAPI,
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<GuardScopeEvaluation> {
	const query: ScopeQuery = { providers: new Map() };
	pi.events.emit(SCOPE_QUERY_CHANNEL, query);
	const providers = [...query.providers].sort(([left], [right]) => left.localeCompare(right));
	const evaluations: Array<
		{ id: string; decision: GuardScopeDecision } | { id: string; error: true }
	> = await Promise.all(providers.map(async ([id, provider]) => {
		try {
			const decision: unknown = await provider(event, ctx);
			return decision === "guard" || decision === "abstain"
				? { id, decision }
				: { id, error: true as const };
		} catch {
			return { id, error: true as const };
		}
	}));
	const failedProviderIds = evaluations
		.filter((evaluation) => "error" in evaluation)
		.map(({ id }) => id);
	if (failedProviderIds.length > 0) {
		return {
			block: true,
			reason: `Blocked because guard scope provider evaluation failed: ${failedProviderIds.join(", ")}.`,
		};
	}
	return evaluations.some((evaluation) => "decision" in evaluation && evaluation.decision === "guard")
		? "guard"
		: "abstain";
}
