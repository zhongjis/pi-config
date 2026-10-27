import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Mode prompt placeholder for the mode-permitted agent roster. */
export const AGENT_ROSTER_PLACEHOLDER = "{{agentRoster}}";

/**
 * Expand `{{agentRoster}}` through the subagents manager bridge, which also claims
 * the roster for this run (`options` identifies it). Empty when the bridge is absent.
 */
export function expandAgentRoster(body: string, ctx: ExtensionContext, options: { readonly sections: Record<string, string> }): string {
	if (!body.includes(AGENT_ROSTER_PLACEHOLDER)) return body;
	const bridge: unknown = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
	const rendered: unknown = typeof bridge === "object" && bridge !== null && "renderAgentRoster" in bridge && typeof bridge.renderAgentRoster === "function"
		? bridge.renderAgentRoster(ctx, options)
		: "";
	const roster = typeof rendered === "string" ? rendered : "";
	// A replacer function keeps `$&`-style sequences in agent descriptions literal.
	return body.replaceAll(AGENT_ROSTER_PLACEHOLDER, () => roster);
}
