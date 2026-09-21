import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelChain, resolveAllAvailable } from "./model-selection.js";
import { isQuotaOrRateLimitError } from "./provider-errors.js";

export type RuntimeModelCandidate = ReturnType<typeof resolveAllAvailable>[number];

export interface RuntimeModelFallbackPolicy {
	/** Evaluated for every settled failure; callers MAY change this chain between episodes. */
	chain(ctx: ExtensionContext): string | undefined;
	/** Reject policy-owned candidate metadata before selecting its model. */
	validate?(candidate: RuntimeModelCandidate, ctx: ExtensionContext): void;
	/** Runs after selection and candidate thinking application; generic Pi APIs cannot apply `fast`. */
	apply(candidate: RuntimeModelCandidate, ctx: ExtensionContext): void;
}

/** Coordinates one user-input episode of post-native-retry quota/rate-limit recovery. */
export function registerRuntimeModelFallback(pi: ExtensionAPI, policy: RuntimeModelFallbackPolicy): void {
	let pending: AssistantMessage | undefined;
	let attempted = new Set<string>();
	let coordinatorSelection: string | undefined;

	const reset = () => { pending = undefined; attempted = new Set(); };
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
		pending = message.stopReason === "error"
			&& !isContextOverflow(message, ctx.model?.contextWindow)
			&& isQuotaOrRateLimitError(message)
			? message
			: undefined;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		const message = pending;
		pending = undefined;
		const signal = ctx.signal;
		if (signal?.aborted || !message || message.stopReason === "aborted" || !ctx.model) return;

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
		if (!selected || signal?.aborted) return;
		if (next.thinkingLevel !== undefined) pi.setThinkingLevel(next.thinkingLevel);
		policy.apply(next, ctx);
		pi.sendMessage({
			customType: "runtime-model-fallback",
			content: "Continue the task from the existing conversation and completed tool results.",
			display: false,
		}, { triggerTurn: true });
	});
}
