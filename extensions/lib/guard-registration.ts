import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FUXI_BASH_GUARD_CAPABILITY = "fuxi-bash" as const;

export type GuardCapability = typeof FUXI_BASH_GUARD_CAPABILITY;

const REGISTRY_KEY = Symbol.for("pi-config.guard-registration-registry");

function getRegistry(): WeakMap<object, Set<GuardCapability>> {
	const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
	if (existing instanceof WeakMap) {
		return existing as WeakMap<object, Set<GuardCapability>>;
	}
	const registry = new WeakMap<object, Set<GuardCapability>>();
	Reflect.set(globalThis, REGISTRY_KEY, registry);
	return registry;
}

function registrationKey(pi: ExtensionAPI): object {
	return typeof pi.events === "object" && pi.events !== null ? pi.events : pi;
}

export function registerGuardCapability(pi: ExtensionAPI, capability: GuardCapability): void {
	const registrations = getRegistry();
	const key = registrationKey(pi);
	const capabilities = registrations.get(key) ?? new Set<GuardCapability>();
	capabilities.add(capability);
	registrations.set(key, capabilities);
}

export function hasGuardCapability(pi: ExtensionAPI, capability: GuardCapability): boolean {
	const registrations = getRegistry();
	return registrations.get(registrationKey(pi))?.has(capability) ?? false;
}
