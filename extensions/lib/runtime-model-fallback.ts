import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelChain, resolveAllAvailable } from "./model-selection.js";
import { isAccessDeniedError, isQuotaError, isQuotaOrRateLimitError } from "./provider-errors.js";

export type RuntimeModelCandidate = ReturnType<typeof resolveAllAvailable>[number];

export interface RuntimeModelFallbackPolicy {
	/** Evaluated for every settled failure; callers MAY change this chain between episodes. */
	chain(ctx: ExtensionContext): string | undefined;
	/** Reject policy-owned candidate metadata before selecting its model. */
	validate?(candidate: RuntimeModelCandidate, ctx: ExtensionContext): void;
	/** Runs after selection and candidate thinking application; generic Pi APIs cannot apply `fast`. */
	apply(candidate: RuntimeModelCandidate, ctx: ExtensionContext): void;
}

/** Coordinates one user-input episode of post-native-retry quota/rate-limit/access-denied recovery. */
export function registerRuntimeModelFallback(pi: ExtensionAPI, policy: RuntimeModelFallbackPolicy): void {
	let pending: AssistantMessage | undefined;
	let attempted = new Set<string>();
	let coordinatorSelection: string | undefined;
	let failures = 0;

	const reset = () => { pending = undefined; attempted = new Set(); failures = 0; };
	const identity = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

	pi.on("session_start", reset);
	pi.on("session_before_switch", reset);
	pi.on("input", (event) => { if (event.source !== "extension") reset(); });
	pi.on("model_select", (event) => {
		if (coordinatorSelection === identity(event.model)) return;
		reset();
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const message = event.message;
		failures = message.stopReason === "error" ? failures + 1 : 0;
		pending = message.stopReason === "error"
			&& !isContextOverflow(message, ctx.model?.contextWindow)
			&& (isQuotaOrRateLimitError(message) || isAccessDeniedError(message))
			? message
			: undefined;
	});
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "error" || event.continue || !pending || !ctx.model
			|| ctx.model.provider !== "cliproxyapi" || !isQuotaError(pending) || failures >= 5) return;
		const model = ctx.model;
		const message = pending;
		const chain = policy.chain(ctx);
		if (!chain || !resolveAllAvailable(parseModelChain(chain), ctx.modelRegistry)
			.some(candidate => identity(candidate.model) === identity(model) || !attempted.has(identity(candidate.model)))) return;

		const entries = event.context.contextEntries;
		const index = entries.findIndex(entry => entry.messages.includes(message));
		const failed = entries[index];
		if (!failed) return;
		const failedToolCalls = new Set(message.content.flatMap(block => block.type === "toolCall" ? [block.id] : []));
		const targets = [failed];
		for (const entry of entries.slice(index + 1)) {
			if (entry.messages.some(message => message.role === "assistant")) break;
			if (entry.messages.some(message => message.role === "toolResult" && failedToolCalls.has(message.toolCallId))) targets.push(entry);
		}
		pending = undefined;
		return { continue: true, entries: targets.map(entry => ({ type: "context_edit" as const, targetId: entry.sourceEntry.id, replacement: null })) };
	});
	pi.on("agent_settled", async (event, ctx) => {
		const message = pending;
		pending = undefined;
		if (event.aborted || !message || !ctx.model) return;

		attempted.add(identity(ctx.model));
		const chain = policy.chain(ctx);
		if (!chain) return;
		const next = resolveAllAvailable(parseModelChain(chain), ctx.modelRegistry)
			.find((candidate) => !attempted.has(identity(candidate.model)));
		if (!next) return;

		attempted.add(identity(next.model));
		policy.validate?.(next, ctx);
		coordinatorSelection = identity(next.model);
		let selected = false;
		try { selected = await pi.setModel(next.model); } finally { coordinatorSelection = undefined; }
		if (!selected) return;
		failures = 0;
		if (next.thinkingLevel !== undefined) pi.setThinkingLevel(next.thinkingLevel);
		policy.apply(next, ctx);
		pi.sendMessage({
			customType: "runtime-model-fallback",
			content: "Continue the task from the existing conversation and completed tool results.",
			display: false,
		}, { triggerTurn: true });
	});
}
