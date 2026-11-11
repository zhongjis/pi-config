import { resolve } from "node:path";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	evaluateGuardScope,
	GUARD_PROFILE_IDS,
	registerGuardCapability,
	SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY,
	type GuardScopeEvaluation,
} from "../../lib/guard-registration.js";
import { evaluateBashPolicy } from "./bash-policy.js";
import { classify } from "./classifier.js";
import { loadGuardProfile } from "./profile.js";

const hookedApis = new WeakSet<ExtensionAPI>();
const issuedBashCommands = new WeakMap<ExtensionAPI, Map<string, string>>();
const PROFILES = new Map(GUARD_PROFILE_IDS.map((id) => [id, loadGuardProfile(id)]));

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

function commandFromArguments(value: unknown): string | undefined {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return isRecord(parsed) && typeof parsed.command === "string" ? parsed.command : undefined;
}

function bashCommandsFromAssistant(message: unknown): Map<string, string> | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	const commands = new Map<string, string>();
	if (!Array.isArray(message.content)) return commands;
	for (const block of message.content) {
		if (
			!isRecord(block) ||
			block.type !== "toolCall" ||
			block.name !== "bash" ||
			typeof block.id !== "string"
		) continue;
		const command = commandFromArguments(block.arguments);
		if (command !== undefined) commands.set(block.id, command);
	}
	return commands;
}

function takeIssuedCommand(pi: ExtensionAPI, toolCallId: string): string | undefined {
	const record = issuedBashCommands.get(pi);
	if (!record) return undefined;
	const command = record.get(toolCallId);
	record.delete(toolCallId);
	return command;
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

/** Active profiles this guard knows; when none is known, every profile it enforces. */
function profileLabel(scope: ActiveGuardScope): string {
	const active = GUARD_PROFILE_IDS.filter((id) => scope.activeScopes.some(({ profile }) => profile === id));
	return (active.length > 0 ? active : GUARD_PROFILE_IDS).join(",");
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
			`[Smart Guard][${category}][source=${source}][profile=${profileLabel(scope)}][scope=${scopeIds.join(",") || "none"}]`,
			`Bash not run: ${terminatedDetail}${activation ? ` Guard active: ${activation}` : ""} Agent capability restriction: this agent is not authorized to run this Bash action; this does not establish a project-wide lack of access. Report the capability limitation and that the command was not executed.`,
		].join("\n"),
	};
}

export default function smartToolGuards(pi: ExtensionAPI): void {
	if (hookedApis.has(pi)) return;

	pi.on("message_end", (event) => {
		const recorded = bashCommandsFromAssistant(event.message);
		if (recorded !== undefined) issuedBashCommands.set(pi, recorded);
	});
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

		// Scopes that disagree on a profile, or name a missing or invalid one, fail closed rather than pick one.
		const profileIds = [...new Set(scope.activeScopes.map(({ profile }) => profile))];
		const loaded = profileIds.length === 1 ? PROFILES.get(profileIds[0]) : undefined;
		if (loaded?.kind !== "loaded") {
			return formatDenial(scope, {
				kind: "scope-error",
				detail: "Unsupported guard profile; guard failed closed.",
			});
		}
		const { profile } = loaded;

		const input: unknown = event.input;
		if (!validBashInput(input)) {
			return formatDenial(scope, { kind: "input-error", detail: "Malformed tool input." });
		}

		const effectiveCwd = resolve(ctx.cwd, input.cwd ?? ".");
		const command = takeIssuedCommand(pi, event.toolCallId) ?? input.command;
		const policy = evaluateBashPolicy(profile, {
			command,
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
			policyId: profile.id,
			policyInstructions: profile.classifier.instructions,
			choices: profile.classifier.choices,
			target: "bash" as const,
			action: {
				command,
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
		issuedBashCommands.delete(pi);
		hookedApis.delete(pi);
	});
	registerGuardCapability(pi, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY);
	hookedApis.add(pi);
}
