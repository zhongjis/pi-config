/**
 * Playbook DSL + faux model driver.
 *
 * The DSL builders (`when`/`calls`/`says`) are ported verbatim from
 * @marcfargas/pi-test-harness (playbook.ts). The ONLY thing that changed for pi
 * 0.83 is the model driver: instead of overriding `agent.streamFn` (which pi
 * 0.83 no longer routes turns through), each action is mapped to a native
 * pi-ai faux response step and fed to the faux provider via `faux.setResponses`.
 *
 * The queue is FLATTENED across turns exactly like the original: each
 * `calls()`/`says()` is ONE assistant message. A `call` → assistant message with
 * one toolCall + stopReason "toolUse". A `say` → assistant message with text +
 * stopReason "stop".
 */

import {
	type AssistantMessage,
	type Context,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { PlaybookAction, ToolResultRecord, Turn } from "./types.js";
import { formatPlaybookDiagnostic } from "./diagnostics.js";

// ── DSL builders ────────────────────────────────────────────

/** Chainable call action builder */
export class CallAction {
	readonly action: PlaybookAction;

	constructor(toolName: string, params: Record<string, unknown> | (() => Record<string, unknown>)) {
		this.action = { type: "call", toolName, params };
	}
}

/**
 * The model calls a tool.
 * @param toolName Tool to call
 * @param params Static params or function for late binding
 */
export function calls(
	toolName: string,
	params: Record<string, unknown> | (() => Record<string, unknown>) = {},
): CallAction {
	return new CallAction(toolName, params);
}

/**
 * The model emits text. Agent loop ends for this turn.
 */
export function says(text: string): PlaybookAction {
	return { type: "say", text };
}

/**
 * Define one user→model turn.
 * @param prompt The actual user prompt text
 * @param actions What the model does in response (call/say sequence)
 */
export function when(prompt: string, actions: Array<CallAction | PlaybookAction>): Turn {
	return {
		prompt,
		actions: actions.map((a) => (a instanceof CallAction ? a.action : a)),
	};
}

// ── Faux model driver ───────────────────────────────────────

export interface PlaybookState {
	consumed: number;
	remaining: number;
	/** The action objects for each consumed step (for diagnostics) */
	consumedActions: PlaybookAction[];
	/** Callbacks pending for completed tool calls */
	pendingCallbacks: Map<string, (result: ToolResultRecord) => void>;
}

export function createPlaybookState(): PlaybookState {
	return {
		consumed: 0,
		remaining: 0,
		consumedActions: [],
		pendingCallbacks: new Map(),
	};
}

function resolveParams(
	params: Record<string, unknown> | (() => Record<string, unknown>) | undefined,
): Record<string, unknown> {
	if (!params) return {};
	if (typeof params === "function") return params();
	return params;
}

/**
 * How many extra dispatcher slots to append beyond the parent's own actions.
 *
 * The faux provider consumes ONE array slot per model call — shared across the
 * parent session AND any subagent sessions it spawns (they inherit the parent's
 * ModelRuntime). Padding covers stray parent retries plus every subagent model
 * call (each idle subagent holds exactly one slot until it is aborted).
 */
const DISPATCHER_PADDING = 64;

function actionToMessage(
	action: PlaybookAction,
	state: PlaybookState,
	nextToolCallId: () => string,
): AssistantMessage {
	if (action.type === "call") {
		const tcId = nextToolCallId();
		const resolvedParams = resolveParams(action.params);
		if (action.thenCallback) {
			state.pendingCallbacks.set(tcId, action.thenCallback);
		}
		return fauxAssistantMessage(
			[fauxToolCall(action.toolName!, resolvedParams, { id: tcId })],
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage([fauxText(action.text ?? "")], { stopReason: "stop" });
}

/**
 * A faux response that never resolves until the model call is aborted — used for
 * subagent sessions the playbook does not script. A background subagent whose
 * model call blocks stays "running" (its active-tool set + durable lifecycle
 * lease intact) exactly like a real slow model, letting a test inspect it before
 * tearing it down. Without this the subagent turn completes instantly and pi's
 * turn_end tool re-narrowing / lease release fires first, corrupting what the
 * test observes.
 */
function stayIdleUntilAborted(
	options: { signal?: AbortSignal } | undefined,
): Promise<AssistantMessage> {
	return new Promise<AssistantMessage>((resolve) => {
		const finish = () =>
			resolve(
				fauxAssistantMessage([fauxText("")], { stopReason: "aborted", errorMessage: "aborted" }),
			);
		const signal = options?.signal;
		if (signal?.aborted) {
			finish();
			return;
		}
		signal?.addEventListener?.("abort", finish, { once: true });
	});
}

/**
 * Build the faux response queue for a run.
 *
 * Instead of a flat FIFO (which a spawned subagent would race the parent to
 * drain), every slot is the SAME context-routing dispatcher: it serves the next
 * scripted action to the PARENT session (identified by `parentSessionId` /
 * `options.sessionId`) and keeps any other (subagent) session idle. Order of
 * interleaved parent/child calls therefore doesn't matter.
 *
 * Steps resolve lazily at model-call time, preserving late-bound params,
 * `.then()` callback registration, and per-action consumption tracking.
 */
export function buildFauxSteps(
	turns: Turn[],
	state: PlaybookState,
	parentSessionId: string | undefined,
	fauxResponseRouter?: (
		context: Context,
		options: StreamOptions | undefined,
	) => AssistantMessage | Promise<AssistantMessage | undefined> | undefined,
): FauxResponseStep[] {
	const queue: PlaybookAction[] = turns.flatMap((t) => t.actions);

	state.consumed = 0;
	state.remaining = queue.length;
	state.consumedActions = [];
	state.pendingCallbacks = new Map();

	let toolCallCounter = 0;
	const nextToolCallId = () => `playbook-tc-${++toolCallCounter}`;

	// The parent session drives the very first model call (a spawned subagent can
	// only call the model AFTER the parent's Agent tool has run). So the first
	// caller's sessionId identifies the parent; every later distinct session is a
	// subagent. `parentSessionId` (from the session object, if resolvable) seeds
	// this; otherwise it is captured dynamically.
	let parentSid = parentSessionId;

	const dispatcher: FauxResponseStep = async (context, options) => {
		const routed = await fauxResponseRouter?.(context, options);
		if (routed) return routed;

		const sid = options?.sessionId;
		if (parentSid === undefined) parentSid = sid;
		const isParent = sid === undefined || sid === parentSid;

		if (!isParent) {
			return stayIdleUntilAborted(options);
		}

		if (state.consumed < queue.length) {
			const action = queue[state.consumed];
			state.consumed++;
			state.remaining = queue.length - state.consumed;
			state.consumedActions.push(action);
			return actionToMessage(action, state, nextToolCallId);
		}

		// Parent called the model more times than scripted — end the turn
		// gracefully (mirrors the original streamFn exhaustion fallback) instead
		// of the faux provider's hard "No more faux responses queued" error.
		const diagnostic = formatPlaybookDiagnostic("exhausted", state);
		return fauxAssistantMessage([fauxText(`[PLAYBOOK EXHAUSTED] ${diagnostic}`)], {
			stopReason: "stop",
		});
	};

	return Array.from({ length: queue.length + DISPATCHER_PADDING }, () => dispatcher);
}
