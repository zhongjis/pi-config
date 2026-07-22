import {
	withFileMutationQueue,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ModeStateManager } from "./mode-state.js";
import {
	getLocalDraftPath,
	getLocalPlanPath,
	hydratePlanState,
	readLocalDraftFile,
	readLocalPlanFile,
	writeLocalDraftFile,
	writeLocalPlanFile,
} from "./plan-storage.js";
import { LOCAL_DRAFT_URI, LOCAL_PLAN_URI } from "./constants.js";
import { firstMeaningfulLine, renderToolCall, renderToolExpanded, renderToolSummary } from "../../lib/tool-output.js";

export const PLAN_SECTION_HEADERS = [
	"## TL;DR (For humans)",
	"## Scope",
	"## Verification strategy",
	"## Execution strategy",
	"## Todos",
	"## Final verification wave",
	"## Commit strategy",
	"## Success criteria",
];

export const FINAL_VERIFICATION_ITEMS = [
	"F1. Plan compliance audit",
	"F2. Code quality review",
	"F3. Real manual QA",
	"F4. Scope fidelity",
];

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

type PlanIntent = "clear" | "unclear";
type ArtifactStatus = "created" | "exists" | "reset";

interface PlanScaffoldParams {
	slug: string;
	intent: PlanIntent;
	draftOnly?: boolean;
	reviewRequired?: boolean;
	reset?: boolean;
	force?: boolean;
}

interface PlanScaffoldArtifact {
	path: typeof LOCAL_DRAFT_URI | typeof LOCAL_PLAN_URI;
	backingPath: string;
	status: ArtifactStatus;
}

function getErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

export function isUlwArtifact(content: string): boolean {
	const isPlan = content.includes("## TL;DR (For humans)") && content.includes("## Final verification wave");
	const isDraft = content.includes("# Draft:") && content.includes("## Approval gate");
	return isPlan || isDraft;
}

export function buildDraft(slug: string, intent: PlanIntent, { reviewRequired = false } = {}): string {
	const assumptionsNote = intent === "unclear"
		? "Intent is UNCLEAR: research resolves ambiguity, defaults are adopted (not asked), and each is surfaced in the plan's human TL;DR for veto."
		: "Record any default you adopt instead of asking, so the user can veto it at the gate.";
	const reviewState = reviewRequired
		? `review_required: true
plan_path: local://PLAN.md
plan_sha256: null
review_round_id: null
pending-action: write and review local://PLAN.md
review:
  yanluo:
    status: pending
    backing_path: local://PLAN.md
    content_delivery: null
    target: local://PLAN.md
    round_id: null
    plan_sha256: null
    launch_id: null
    session: null
    result: null
  taishang:
    status: pending
    backing_path: local://PLAN.md
    content_delivery: null
    target: local://PLAN.md
    round_id: null
    plan_sha256: null
    launch_id: null
    session: null
    result: null`
		: `review_required: false
pending-action: write local://PLAN.md`;
	return `---
slug: ${slug}
status: drafting
intent: ${intent}
${reviewState}
approach: <fill: the approach you intend to plan>
---

# Draft: ${slug}

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

## Open assumptions (announced defaults)
<!-- ${assumptionsNote} -->
<!-- assumption | adopted default | rationale | reversible? -->

## Findings (cited - path:lines)

## Decisions (with rationale)

## Scope IN

## Scope OUT (Must NOT have)

## Open questions

## Approval gate
status: drafting
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
`;
}

export function buildPlanSkeleton(slug: string, intent: PlanIntent): string {
	const decisionsLine = intent === "unclear"
		? "**Decisions I made for you:** <fill last - the best-practice defaults you adopted; the user vetoes any here>"
		: "**Decisions to sanity-check:** <fill last - the few choices worth a human glance>";
	return `# ${slug} - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** <fill last - deliverables in human terms, 1-2 sentences>

**Why this approach:** <fill last - the one or two load-bearing decisions and why>

**What it will NOT do:** <fill last - 1-3 plain lines mirroring Must NOT have>

**Effort:** <Quick | Short | Medium | Large | XL>
**Risk:** <Low | Medium | High> - <one-line driver>
${decisionsLine}

Your next move: <fill - e.g. approve, or run a high-accuracy review>. Full execution detail follows below.

---

> TL;DR (machine): <1 line - effort, risk, deliverables>

## Scope
### Must have
### Must NOT have (guardrails, anti-slop, scope boundaries)

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: <TDD | tests-after | none> + framework
- Evidence: <durable-evidence-path>/task-<N>-${slug}.<ext>

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit - never rewrite the headers above. -->
- [ ] 1. <title>
  What to do / Must NOT do: <...>
  Parallelization: Wave <N> | Blocked by: <...> | Blocks: <...>
  References (executor has NO interview context - be exhaustive): <src/path:lines>
  Acceptance criteria (agent-executable): <exact command or assertion>
  QA scenarios (name the exact tool + invocation): happy + failure, Evidence <durable-evidence-path>/task-1-${slug}.<ext>
  Commit: <Y/N> | <type>(<scope>): <summary>

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
${FINAL_VERIFICATION_ITEMS.map((item) => `- [ ] ${item}`).join("\n")}

## Commit strategy

## Success criteria
`;
}

async function readExisting(read: () => Promise<string>): Promise<string | null> {
	try {
		return await read();
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return null;
		throw error;
	}
}

async function writeGuarded(
	path: PlanScaffoldArtifact["path"],
	backingPath: string,
	content: string,
	read: () => Promise<string>,
	write: (content: string) => Promise<string>,
	{ reset = false, force = false }: Pick<PlanScaffoldParams, "reset" | "force">,
): Promise<PlanScaffoldArtifact> {
	return withFileMutationQueue(backingPath, async () => {
		const existing = await readExisting(read);
		if (existing && existing.trim() !== "") {
			if (!reset) {
				if (isUlwArtifact(existing)) return { path, backingPath, status: "exists" };
				throw new Error(`refused: ${path} exists and is not a ulw-plan artifact (pass reset: true to overwrite)`);
			}
			if (existing.trim() !== content.trim() && !force) {
				throw new Error(`refused: ${path} has edits that differ from a fresh skeleton; pass reset: true, force: true to discard them`);
			}
		}
		await write(content);
		return { path, backingPath, status: existing ? "reset" : "created" };
	});
}

async function scaffold(
	ctx: ExtensionContext,
	state: ModeStateManager,
	params: PlanScaffoldParams,
): Promise<PlanScaffoldArtifact[]> {
	if (!SLUG_PATTERN.test(params.slug)) {
		throw new Error(`invalid slug "${params.slug}" - use lowercase letters, digits, and hyphens only`);
	}

	const options = { reset: params.reset, force: params.force };
	const draft = await writeGuarded(
		LOCAL_DRAFT_URI,
		getLocalDraftPath(ctx),
		buildDraft(params.slug, params.intent, { reviewRequired: params.reviewRequired }),
		() => readLocalDraftFile(ctx),
		(content) => writeLocalDraftFile(ctx, content),
		options,
	);
	if (params.draftOnly) return [draft];

	const plan = await writeGuarded(
		LOCAL_PLAN_URI,
		getLocalPlanPath(ctx),
		buildPlanSkeleton(params.slug, params.intent),
		() => readLocalPlanFile(ctx),
		(content) => writeLocalPlanFile(ctx, content),
		options,
	);
	if (plan.status !== "exists") {
		await hydratePlanState(ctx as never, state);
		state.resetPlanReviewState();
		state.persistState();
	}
	return [draft, plan];
}

function formatResult(artifacts: PlanScaffoldArtifact[], draftOnly: boolean): string {
	const created = artifacts.some((artifact) => artifact.status !== "exists");
	const lines = artifacts.map((artifact) => `${artifact.status}: ${artifact.path}`);
	lines.push(
		draftOnly
			? "next: record intent, findings, decisions, review state, and the approval gate in the draft; create the plan only after approval."
			: created
				? 'next: record findings/decisions in the draft, then APPEND task batches into the "## Todos" region of the plan; fill "## TL;DR (For humans)" LAST.'
				: 'skeleton already present - left untouched. APPEND task batches into the "## Todos" region; the human "## TL;DR (For humans)" stays on top.',
	);
	return lines.join("\n");
}

type PlanScaffoldToolResult = AgentToolResult<{ artifacts?: PlanScaffoldArtifact[] }> & { isError?: boolean };
type PlanScaffoldTheme = Pick<Theme, "fg" | "bold">;
type PlanScaffoldRenderContext = { args?: Partial<PlanScaffoldParams>; isError?: boolean };

function getResultText(result: PlanScaffoldToolResult | undefined): string {
	return (result?.content ?? [])
		.filter((part) => part?.type === "text")
		.map((part) => typeof part.text === "string" ? part.text : "")
		.join("\n");
}

function isScaffoldArtifact(value: unknown): value is PlanScaffoldArtifact {
	if (!value || typeof value !== "object") return false;
	const artifact = value as { path?: unknown; backingPath?: unknown; status?: unknown };
	return (artifact.path === LOCAL_DRAFT_URI || artifact.path === LOCAL_PLAN_URI)
		&& typeof artifact.backingPath === "string"
		&& (artifact.status === "created" || artifact.status === "exists" || artifact.status === "reset");
}

function getArtifacts(result: PlanScaffoldToolResult | undefined): PlanScaffoldArtifact[] | null {
	const artifacts = result?.details?.artifacts;
	if (artifacts === undefined) return [];
	if (!Array.isArray(artifacts)) return null;
	return artifacts.every(isScaffoldArtifact) ? artifacts : null;
}

function renderSummary(lines: string[], theme: PlanScaffoldTheme): Text {
	return renderToolSummary(lines, theme, { expandable: true, expandLabel: "to expand full result" });
}

function renderPlanScaffoldCall(args: Partial<PlanScaffoldParams> | undefined, theme: PlanScaffoldTheme): Text {
	const mode = args?.draftOnly === true ? "draft only" : "draft + plan";
	const slug = typeof args?.slug === "string" ? `\"${args.slug}\"` : undefined;
	const intent = args?.intent;
	const flags = [
		args?.reviewRequired === true ? "review required" : undefined,
		args?.reset === true ? "reset" : undefined,
		args?.force === true ? "force" : undefined,
	].filter((flag): flag is string => Boolean(flag));
	const target = [mode, slug, intent, ...flags].filter((part): part is string => Boolean(part)).join(" · ");
	return renderToolCall("plan_scaffold", target, theme);
}

function renderPlanScaffoldResult(
	result: PlanScaffoldToolResult | undefined,
	options: Partial<Pick<ToolRenderResultOptions, "expanded" | "isPartial">> = {},
	theme: PlanScaffoldTheme,
	context: PlanScaffoldRenderContext = {},
): Text | ReturnType<typeof renderToolExpanded> {
	const text = getResultText(result);
	if (options.expanded) return renderToolExpanded(text);

	if (options.isPartial) {
		const target = context.args?.draftOnly === true ? "draft" : "draft + plan";
		return renderSummary([`status: creating ${target}`], theme);
	}

	if (context.isError || result?.isError) {
		return renderSummary([`error: ${firstMeaningfulLine(text) || "unknown error"}`], theme);
	}

	const artifacts = getArtifacts(result);
	if (!artifacts) {
		const fallback = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(0, 2);
		return renderSummary(fallback.length > 0 ? fallback : ["empty result"], theme);
	}
	const artifactSummary = artifacts.length > 0
		? artifacts.map((artifact) => `${artifact.path.replace("local://", "")} ${artifact.status}`).join(" · ")
		: "none";
	const next = context.args?.draftOnly === true ? "populate DRAFT.md" : "populate PLAN.md";
	return renderSummary([`artifacts: ${artifactSummary}`, `next: ${next}`], theme);
}

export function registerPlanScaffoldTool(pi: ExtensionAPI, state: ModeStateManager): void {
	pi.registerTool({
		name: "plan_scaffold",
		label: "Plan Scaffold",
		description: "Create canonical Fu Xi draft and plan skeletons in session-local storage without shell access or arbitrary paths.",
		parameters: Type.Object({
			slug: Type.String({ description: "Lowercase letters, digits, and hyphens; maximum 80 characters." }),
			intent: Type.Union([Type.Literal("clear"), Type.Literal("unclear")]),
			draftOnly: Type.Optional(Type.Boolean()),
			reviewRequired: Type.Optional(Type.Boolean()),
			reset: Type.Optional(Type.Boolean()),
			force: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
		renderCall(args, theme) {
			return renderPlanScaffoldCall(args as Partial<PlanScaffoldParams>, theme);
		},
		renderResult(result, options, theme, context) {
			return renderPlanScaffoldResult(
				result as PlanScaffoldToolResult,
				options,
				theme,
				context as PlanScaffoldRenderContext,
			);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const artifacts = await scaffold(ctx, state, params as PlanScaffoldParams);
			return {
				content: [{ type: "text" as const, text: formatResult(artifacts, params.draftOnly === true) }],
				details: { artifacts },
			};
		},
	});
}
