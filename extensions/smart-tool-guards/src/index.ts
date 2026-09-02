import { resolve } from "node:path";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	evaluateGuardScope,
	registerGuardCapability,
	SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY,
	type GuardScopeEvaluation,
} from "../../lib/guard-registration.js";
import { evaluateBashPolicy } from "./bash-policy.js";
import { classify } from "./classifier.js";

const hookedApis = new WeakSet<ExtensionAPI>();
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

type ActiveGuardScope = Extract<GuardScopeEvaluation, { readonly decision: "guard" | "error" }>;
type GuardDenial =
	| { readonly kind: "policy"; readonly detail: string }
	| { readonly kind: "classifier-block"; readonly detail: string }
	| { readonly kind: "input-error"; readonly detail: string }
	| { readonly kind: "classifier-error"; readonly detail: string }
	| { readonly kind: "scope-error"; readonly detail: string };

const DENIAL_CATEGORY = {
	policy: { category: "BLOCK", source: "policy" },
	"classifier-block": { category: "BLOCK", source: "classifier" },
	"input-error": { category: "ERROR", source: "input" },
	"classifier-error": { category: "ERROR", source: "classifier" },
	"scope-error": { category: "ERROR", source: "scope" },
} as const;

function normalizeLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function formatDenial(
	scope: ActiveGuardScope,
	denial: GuardDenial,
): { readonly block: true; readonly reason: string } {
	const failedProviderIds = scope.decision === "error" ? scope.failedProviderIds : [];
	const scopeIds = [...new Set([
		...scope.activeScopes.map(({ id }) => id),
		...failedProviderIds,
	])].sort((left, right) => left.localeCompare(right));
	const activation = scope.activeScopes
		.map(({ reason }) => normalizeLine(reason))
		.join(" ");
	const { category, source } = DENIAL_CATEGORY[denial.kind];
	const detail = normalizeLine(denial.detail);
	const terminatedDetail = /[.!?]$/.test(detail) ? detail : `${detail}.`;
	return {
		block: true,
		reason: [
			`[Smart Guard][${category}][source=${source}][profile=${BASH_POLICY_ID}][scope=${scopeIds.join(",") || "none"}]`,
			`Bash not run: ${terminatedDetail}${activation ? ` Guard active: ${activation}` : ""}`,
		].join("\n"),
	};
}

export default function smartToolGuards(pi: ExtensionAPI): void {
	if (hookedApis.has(pi)) return;

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const scope = await evaluateGuardScope(pi, event, ctx);
		if (scope.decision === "abstain") return;
		if (scope.decision === "error") {
			return formatDenial(scope, {
				kind: "scope-error",
				detail: `Scope evaluation failed for providers: ${scope.failedProviderIds.join(", ")}; guard failed closed.`,
			});
		}

		const input: unknown = event.input;
		if (!validBashInput(input)) {
			return formatDenial(scope, { kind: "input-error", detail: "Malformed tool input." });
		}

		const effectiveCwd = resolve(ctx.cwd, input.cwd ?? ".");
		const policy = evaluateBashPolicy({
			command: input.command,
			requestedCwd: input.cwd,
			requestedTimeout: input.timeout,
			effectiveCwd,
		});
		if (policy.kind === "block") {
			return formatDenial(scope, {
				kind: "policy",
				detail: `Read-only policy matched: ${policy.findings.map(({ code }) => code).join(", ")}.`,
			});
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
		if (verdict.kind === "block") {
			return formatDenial(scope, {
				kind: "classifier-block",
				detail: normalizeLine(verdict.reason),
			});
		}
		return formatDenial(scope, {
			kind: "classifier-error",
			detail: "Classifier unavailable; guard failed closed.",
		});
	});
	pi.on("session_shutdown", () => {
		hookedApis.delete(pi);
	});
	registerGuardCapability(pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY);
	hookedApis.add(pi);
}
