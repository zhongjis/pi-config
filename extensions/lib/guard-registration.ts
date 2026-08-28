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

const CAPABILITY_REGISTRY_KEY = Symbol.for("pi-config.guard-registration-registry");
const SCOPE_PROVIDER_REGISTRY_KEY = Symbol.for("pi-config.guard-scope-provider-registry");

function getCapabilityRegistry(): WeakMap<object, Set<GuardCapability>> {
	const existing: unknown = Reflect.get(globalThis, CAPABILITY_REGISTRY_KEY);
	if (existing instanceof WeakMap) {
		return existing as WeakMap<object, Set<GuardCapability>>;
	}
	const registry = new WeakMap<object, Set<GuardCapability>>();
	Reflect.set(globalThis, CAPABILITY_REGISTRY_KEY, registry);
	return registry;
}

function getScopeProviderRegistry(): WeakMap<object, Map<string, GuardScopeProvider>> {
	const existing: unknown = Reflect.get(globalThis, SCOPE_PROVIDER_REGISTRY_KEY);
	if (existing instanceof WeakMap) {
		return existing as WeakMap<object, Map<string, GuardScopeProvider>>;
	}
	const registry = new WeakMap<object, Map<string, GuardScopeProvider>>();
	Reflect.set(globalThis, SCOPE_PROVIDER_REGISTRY_KEY, registry);
	return registry;
}

function registrationKey(pi: ExtensionAPI): object {
	return typeof pi.events === "object" && pi.events !== null ? pi.events : pi;
}

export function registerGuardCapability(pi: ExtensionAPI, capability: GuardCapability): void {
	const registrations = getCapabilityRegistry();
	const key = registrationKey(pi);
	const capabilities = registrations.get(key) ?? new Set<GuardCapability>();
	capabilities.add(capability);
	registrations.set(key, capabilities);
}

export function hasGuardCapability(pi: ExtensionAPI, capability: GuardCapability): boolean {
	return getCapabilityRegistry().get(registrationKey(pi))?.has(capability) ?? false;
}

export function registerGuardScopeProvider(pi: ExtensionAPI, id: string, provider: GuardScopeProvider): void {
	if (!id.trim()) throw new Error("Guard scope provider ID must not be empty.");
	const registrations = getScopeProviderRegistry();
	const key = registrationKey(pi);
	const providers = registrations.get(key) ?? new Map<string, GuardScopeProvider>();
	providers.set(id, provider);
	registrations.set(key, providers);
}

export async function evaluateGuardScope(
	pi: ExtensionAPI,
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<GuardScopeEvaluation> {
	const providers = [...(getScopeProviderRegistry().get(registrationKey(pi)) ?? [])]
		.sort(([left], [right]) => left.localeCompare(right));
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
