import { resolve } from "node:path";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	evaluateGuardScope,
	registerGuardCapability,
	SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY,
} from "../../lib/guard-registration.js";
import { evaluateBashPolicy } from "./bash-policy.js";
import { classify } from "./classifier.js";

const hookedApis = new WeakSet<ExtensionAPI>();
const INVALID_INPUT_REASON = "Blocked because bash tool input is invalid.";
const CLASSIFIER_UNAVAILABLE_REASON = "Blocked because the bash safety classifier is unavailable.";
const BASH_POLICY_ID = "bash-read-only-v1";
const BASH_POLICY_INSTRUCTIONS = [
	"Allow only bash actions that are read-only.",
	"The guarded bash tool is the evaluation context; using it does not itself count as shell execution.",
	"Block actions that may mutate local, version-control, service, or external-system state.",
	"Block commands that invoke a shell or language interpreter as an executable, or that execute downloaded or generated code.",
	"Allow fixed text written only to stdout, such as `printf classifier-ok`, when no other side effect is present.",
	"When uncertain whether the exact action is read-only, block.",
].join("\n");

interface ValidBashInput {
	command: string;
	cwd?: string;
	timeout?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBashInput(value: unknown): value is ValidBashInput {
	if (!isRecord(value) || typeof value.command !== "string") return false;
	if (value.cwd !== undefined && typeof value.cwd !== "string") return false;
	return value.timeout === undefined ||
		typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout >= 0;
}

export default function smartToolGuards(pi: ExtensionAPI): void {
	if (hookedApis.has(pi)) return;

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const scope = await evaluateGuardScope(pi, event, ctx);
		if (scope === "abstain") return;
		if (typeof scope === "object") return scope;

		const input: unknown = event.input;
		if (!validBashInput(input)) return { block: true, reason: INVALID_INPUT_REASON };

		const effectiveCwd = resolve(ctx.cwd, input.cwd ?? ".");
		const policy = evaluateBashPolicy({
			command: input.command,
			requestedCwd: input.cwd,
			requestedTimeout: input.timeout,
			effectiveCwd,
		});
		if (policy.kind === "block") {
			return {
				block: true,
				reason: `Blocked dangerous bash command: ${policy.findings.map(({ code }) => code).join(", ")}`,
			};
		}
		if (policy.kind === "allow") return;

		const verdict = await classify({
			policyId: BASH_POLICY_ID,
			policyInstructions: BASH_POLICY_INSTRUCTIONS,
			target: "bash" as const,
			action: {
				command: input.command,
				requestedCwd: input.cwd,
				requestedTimeout: input.timeout,
			},
			context: { effectiveCwd },
		}, ctx);
		if (verdict.kind === "allow") return;
		if (verdict.kind === "block") return { block: true, reason: verdict.reason };
		return { block: true, reason: CLASSIFIER_UNAVAILABLE_REASON };
	});
	pi.on("session_shutdown", () => {
		hookedApis.delete(pi);
	});
	registerGuardCapability(pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY);
	hookedApis.add(pi);
}
