export interface DelegationPolicy {
    allowDelegationTo?: string[];
    disallowDelegationTo?: string[];
}
interface ModeStateEntryLike {
    type?: string;
    customType?: string;
    data?: {
        mode?: unknown;
    };
}
export declare function hasDelegationPolicy(policy: DelegationPolicy): boolean;
export declare function getPermittedDelegationTypes(policy: DelegationPolicy, availableTypes: string[]): string[];
export declare function resolveDelegationRequest(policy: DelegationPolicy, requestedType: string, availableTypes: string[]): {
    allowed: boolean;
    requestedType: string;
    permittedTypes: string[];
};
export declare function buildDelegationBlockedMessage(delegatorType: string, requestedType: string, resolvedType: string, permittedTypes: string[]): string;
export declare function getCurrentDelegatorType(entries: ModeStateEntryLike[]): string | undefined;
