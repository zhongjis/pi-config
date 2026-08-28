import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const FINAL_VERIFICATION_ITEMS = [
	"F1. Plan compliance audit — owned by `taishang`",
	"F2. Code quality review — orchestrator-owned code-quality gate",
	"F3. Real manual QA — orchestrator manual QA",
	"F4. Scope fidelity — owned by `direnjie`",
];

function expectedDraft(slug: string, intent: "clear" | "unclear", reviewRequired = false): string {
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

function expectedPlan(slug: string, intent: "clear" | "unclear"): string {
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
> Runs in parallel after ALL todos. ALL must APPROVE. Surface all four approvals, then wait for the user's explicit okay before declaring complete.
${FINAL_VERIFICATION_ITEMS.map((item) => `- [ ] ${item}`).join("\n")}

## Commit strategy

## Success criteria
`;
}

type RenderableText = { render?: (width?: number) => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolResult = {
	content?: Array<{ type: "text"; text: string }>;
	details?: { artifacts?: unknown };
	isError?: boolean;
};

type RegisteredTool = {
	parameters: { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: string[] };
	execute: (...args: any[]) => Promise<any>;
	renderCall?: (args: Record<string, unknown>, theme: PlainTheme) => RenderableText;
	renderResult?: (
		result: ToolResult,
		options: { expanded?: boolean; isPartial?: boolean },
		theme: PlainTheme,
		context?: { args?: Record<string, unknown>; isError?: boolean },
	) => RenderableText;
};

const plainTheme: PlainTheme = {
	fg: vi.fn((_color: string, text: string) => text),
	bold: vi.fn((text: string) => text),
};

function renderText(component: RenderableText, width = 80): string {
	if (typeof component.render === "function") return component.render(width).join("\n");
	return component.text ?? "";
}

function createMockPi() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const eventListeners = new Map<string, Set<(data: unknown) => void>>();
	let activeTools = ["read", "write", "plan_approve", "plan_scaffold"];
	const pi = {
		appendEntry: vi.fn(),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				for (const listener of [...(eventListeners.get(channel) ?? [])]) listener(data);
			}),
			on(channel: string, listener: (data: unknown) => void) {
				const listeners = eventListeners.get(channel) ?? new Set<(data: unknown) => void>();
				listeners.add(listener);
				eventListeners.set(channel, listeners);
				return () => listeners.delete(listener);
			},
		},
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		getFlag: vi.fn(() => "kuafu"),
		getThinkingLevel: vi.fn(() => "off"),
		on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
		registerCommand: vi.fn(),
		registerFlag: vi.fn(),
		registerShortcut: vi.fn(),
		registerTool: vi.fn((definition: RegisteredTool & { name: string }) => tools.set(definition.name, definition)),
		sendUserMessage: vi.fn(),
		setActiveTools: vi.fn((names: string[]) => { activeTools = names; }),
		setModel: vi.fn(),
		setThinkingLevel: vi.fn(),
	};
	return { handlers, pi, tools };
}

describe("plan_scaffold", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;
	let sessionId: string;

	beforeEach(async () => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		agentDir = await mkdtemp(join(tmpdir(), "plan-scaffold-test-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		sessionId = "session-plan-scaffold";
	});

	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	async function setup() {
		const { default: initModesExtension } = await import("../src/index.js");
		const runtime = createMockPi();
		initModesExtension(runtime.pi as never);
		const tool = runtime.tools.get("plan_scaffold");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("plan_scaffold missing");
		const ctx = {
			hasUI: false,
			modelRegistry: { getAll: () => [], getAvailable: () => [] },
			sessionManager: { getEntries: (): any[] => [], getSessionId: () => sessionId },
			ui: { setStatus: vi.fn() },
		};
		return { ...runtime, ctx, tool };
	}

	it("renders distinct draft-only and plan call headers", async () => {
		const { tool } = await setup();
		const draft = renderText(tool.renderCall!({ slug: "ship-widget", intent: "clear", draftOnly: true }, plainTheme));
		const plan = renderText(tool.renderCall!({ slug: "ship-widget", intent: "clear" }, plainTheme));

		expect(draft).toBe('▸ plan_scaffold · draft only · "ship-widget" · clear');
		expect(plan).toBe('▸ plan_scaffold · draft + plan · "ship-widget" · clear');
	});

	it("summarizes artifact statuses without changing raw content", async () => {
		const { ctx, tool } = await setup();
		await execute(tool, ctx, { slug: "ship-widget", intent: "clear", draftOnly: true });
		const result = await execute(tool, ctx, { slug: "ship-widget", intent: "clear" });
		const raw = result.content[0].text;
		const content = result.content;

		const collapsed = renderText(tool.renderResult!(result, {}, plainTheme, {
			args: { slug: "ship-widget", intent: "clear" },
		}));

		expect(collapsed).toContain("artifacts: DRAFT.md exists · PLAN.md created");
		expect(collapsed).toContain("next: populate PLAN.md");
		expect(collapsed).toContain("to expand full result");
		expect(collapsed).not.toContain("▸ plan_scaffold");
		expect(result.content).toBe(content);
		expect(result.content[0].text).toBe(raw);
	});

	it("preserves exact expanded output", async () => {
		const { ctx, tool } = await setup();
		const result = await execute(tool, ctx, { slug: "expanded-plan", intent: "unclear", draftOnly: true });
		const raw = result.content[0].text;

		expect(renderText(tool.renderResult!(result, { expanded: true }, plainTheme), 1000)).toBe(raw);
	});

	it("renders partial and error states safely", async () => {
		const { tool } = await setup();
		const partial = renderText(tool.renderResult!(
			{ content: [] },
			{ isPartial: true },
			plainTheme,
			{ args: { slug: "ship-widget", draftOnly: true } },
		));
		const error = renderText(tool.renderResult!(
			{ content: [{ type: "text", text: "refused: local://PLAN.md has edits\nstack hidden" }], isError: true },
			{},
			plainTheme,
			{ isError: true },
		));

		expect(partial).toContain("status: creating draft");
		expect(error).toContain("error: refused: local://PLAN.md has edits");
		expect(error).not.toContain("stack hidden");
		expect(error).toContain("to expand full result");
	});

	it("keeps scaffold renderers width-safe and side-effect free", async () => {
		const { ctx, pi, tool } = await setup();
		const result = await execute(tool, ctx, { slug: "wide-render", intent: "clear" });
		const eventCount = pi.events.emit.mock.calls.length;
		const appendCount = pi.appendEntry.mock.calls.length;
		const widths = [0, 1, 2, 8, 20, 40, 80, 120];

		for (const width of widths) {
			for (const component of [
				tool.renderCall!({ slug: "long-界-emoji", intent: "unclear", reviewRequired: true }, plainTheme),
				tool.renderResult!(result, {}, plainTheme, { args: { slug: "wide-render", intent: "clear" } }),
				tool.renderResult!(result, { expanded: true }, plainTheme),
			]) {
				const rendered = component.render?.(width) ?? [component.text ?? ""];
				expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		}

		expect(pi.events.emit).toHaveBeenCalledTimes(eventCount);
		expect(pi.appendEntry).toHaveBeenCalledTimes(appendCount);
	});

	it("falls back to raw scaffold text when details are malformed", async () => {
		const { tool } = await setup();
		const result = {
			content: [{ type: "text" as const, text: "created: local://DRAFT.md\nnext: do exact raw thing" }],
			details: { artifacts: "broken" },
		};

		const collapsed = renderText(tool.renderResult!(result, {}, plainTheme, { args: { draftOnly: true } }));

		expect(collapsed).toContain("created: local://DRAFT.md");
		expect(collapsed).toContain("next: do exact raw thing");
	});

	async function execute(tool: RegisteredTool, ctx: unknown, params: Record<string, unknown>) {
		return tool.execute("tool-plan-scaffold", params, undefined, undefined, ctx);
	}

	function artifactPath(name: "DRAFT.md" | "PLAN.md") {
		return join(agentDir, "local", sessionId, name);
	}

	it("registers the fixed API and creates canonical session-local draft and plan artifacts", async () => {
		const { ctx, tool } = await setup();
		expect(Object.keys(tool.parameters.properties ?? {}).sort()).toEqual([
			"draftOnly", "force", "intent", "reset", "reviewRequired", "slug",
		]);
		expect(tool.parameters.required).toEqual(["slug", "intent"]);
		expect(tool.parameters.additionalProperties).toBe(false);

		const result = await execute(tool, ctx, { slug: "ship-widget", intent: "clear" });

		expect(await readFile(artifactPath("DRAFT.md"), "utf8")).toBe(expectedDraft("ship-widget", "clear"));
		expect(await readFile(artifactPath("PLAN.md"), "utf8")).toBe(expectedPlan("ship-widget", "clear"));
		expect(result.details.artifacts).toEqual([
			{ path: "local://DRAFT.md", backingPath: artifactPath("DRAFT.md"), status: "created" },
			{ path: "local://PLAN.md", backingPath: artifactPath("PLAN.md"), status: "created" },
		]);
	});

	it("scaffolds explicit final-wave ownership and user completion approval", async () => {
		const { ctx, tool } = await setup();
		await execute(tool, ctx, { slug: "owned-final-wave", intent: "clear" });
		const plan = await readFile(artifactPath("PLAN.md"), "utf8");

		expect.soft(plan, "F1 must name taishang ownership").toMatch(
			/- \[ \] F1\. Plan compliance audit[^\n]{0,100}`taishang`/i,
		);
		expect.soft(plan, "F2 must name orchestrator code-quality ownership").toMatch(
			/- \[ \] F2\. Code quality review[^\n]{0,120}orchestrator-owned code-quality gate/i,
		);
		expect.soft(plan, "F3 must name orchestrator manual-QA ownership").toMatch(
			/- \[ \] F3\. Real manual QA[^\n]{0,100}orchestrator manual QA/i,
		);
		expect.soft(plan, "F4 must name direnjie ownership").toMatch(
			/- \[ \] F4\. Scope fidelity[^\n]{0,100}`direnjie`/i,
		);
		expect.soft(plan, "all approvals must be surfaced").toMatch(
			/surface all four approvals/i,
		);
		expect(plan, "completion requires explicit user okay").toMatch(
			/wait for (?:the )?user(?:'s)? explicit okay before declaring complete/i,
		);
		expect(plan, "final wave must not complete autonomously").not.toMatch(
			/complete autonomously/i,
		);
	});

	it("serializes concurrent scaffolds on the real backing path", async () => {
		const { ctx, tool } = await setup();
		const [first, second] = await Promise.all([
			execute(tool, ctx, { slug: "queue-first", intent: "clear", draftOnly: true }),
			execute(tool, ctx, { slug: "queue-second", intent: "unclear", draftOnly: true }),
		]);

		expect(first.details.artifacts[0].status).toBe("created");
		expect(second.details.artifacts[0].status).toBe("exists");
		expect(first.details.artifacts[0].backingPath).toBe(artifactPath("DRAFT.md"));
		expect(second.details.artifacts[0].backingPath).toBe(artifactPath("DRAFT.md"));
		expect(await readFile(artifactPath("DRAFT.md"), "utf8")).toBe(expectedDraft("queue-first", "clear"));
	});

	it("rejects invalid slugs without creating artifacts", async () => {
		const { ctx, tool } = await setup();
		await expect(execute(tool, ctx, { slug: "../escape", intent: "clear" }))
			.rejects.toThrow('invalid slug "../escape" - use lowercase letters, digits, and hyphens only');
		await expect(readFile(artifactPath("DRAFT.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("leaves existing scaffold artifacts untouched on a plain rerun", async () => {
		const { ctx, tool } = await setup();
		await execute(tool, ctx, { slug: "resume-safe", intent: "clear" });
		const editedDraft = `${await readFile(artifactPath("DRAFT.md"), "utf8")}\nuser note\n`;
		const editedPlan = `${await readFile(artifactPath("PLAN.md"), "utf8")}\n- [ ] custom todo\n`;
		await writeFile(artifactPath("DRAFT.md"), editedDraft, "utf8");
		await writeFile(artifactPath("PLAN.md"), editedPlan, "utf8");

		const result = await execute(tool, ctx, { slug: "resume-safe", intent: "unclear" });

		expect(await readFile(artifactPath("DRAFT.md"), "utf8")).toBe(editedDraft);
		expect(await readFile(artifactPath("PLAN.md"), "utf8")).toBe(editedPlan);
		expect(result.details.artifacts.map((artifact: { status: string }) => artifact.status)).toEqual(["exists", "exists"]);
	});

	it("refuses to overwrite a non-artifact without reset", async () => {
		const { ctx, tool } = await setup();
		await mkdir(join(agentDir, "local", sessionId), { recursive: true });
		await writeFile(artifactPath("DRAFT.md"), "personal notes\n", "utf8");

		await expect(execute(tool, ctx, { slug: "safe-write", intent: "clear" }))
			.rejects.toThrow("refused: local://DRAFT.md exists and is not a ulw-plan artifact (pass reset: true to overwrite)");
		expect(await readFile(artifactPath("DRAFT.md"), "utf8")).toBe("personal notes\n");
	});

	it("requires force to reset edited artifacts, then restores fresh canonical content", async () => {
		const { ctx, pi, tool } = await setup();
		await execute(tool, ctx, { slug: "reset-safe", intent: "clear" });
		await writeFile(artifactPath("PLAN.md"), `${expectedPlan("reset-safe", "clear")}edited\n`, "utf8");
		pi.appendEntry.mockClear();

		await expect(execute(tool, ctx, { slug: "reset-safe", intent: "clear", reset: true }))
			.rejects.toThrow("refused: local://PLAN.md has edits that differ from a fresh skeleton; pass reset: true, force: true to discard them");

		const result = await execute(tool, ctx, { slug: "reset-safe", intent: "clear", reset: true, force: true });
		expect(await readFile(artifactPath("PLAN.md"), "utf8")).toBe(expectedPlan("reset-safe", "clear"));
		expect(result.details.artifacts.map((artifact: { status: string }) => artifact.status)).toEqual(["reset", "reset"]);
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("agent-mode", expect.objectContaining({
			planContent: expectedPlan("reset-safe", "clear"),
			planReviewPending: false,
			planReviewApproved: false,
		}));
	});

	it("creates a review-required draft without a plan when draftOnly is true", async () => {
		const { ctx, tool } = await setup();
		const result = await execute(tool, ctx, {
			slug: "review-first",
			intent: "unclear",
			draftOnly: true,
			reviewRequired: true,
		});
		expect(await readFile(artifactPath("DRAFT.md"), "utf8")).toBe(expectedDraft("review-first", "unclear", true));
		await expect(readFile(artifactPath("PLAN.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(result.details.artifacts).toEqual([
			{ path: "local://DRAFT.md", backingPath: artifactPath("DRAFT.md"), status: "created" },
		]);
	});

	it("resets stale approval state and persists hydrated plan state after plan creation", async () => {
		const { ctx, handlers, pi, tool } = await setup();
		ctx.sessionManager.getEntries = () => [{
			type: "custom",
			customType: "agent-mode",
			data: {
				mode: "fuxi",
				planReviewApproved: true,
				planReviewFeedback: "stale feedback",
				delegationPolicy: { version: 1, allowDelegationTo: [], disallowDelegationTo: [] },
			},
		}];
		await handlers.get("session_start")?.({}, ctx);
		pi.appendEntry.mockClear();

		await execute(tool, ctx, { slug: "fresh-state", intent: "clear" });

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("agent-mode", expect.objectContaining({
			planContent: expectedPlan("fresh-state", "clear"),
			planTitle: "fresh-state - Work Plan",
			planTitleSource: "content-h1",
			planReviewId: undefined,
			planReviewPending: false,
			planReviewApproved: false,
			planReviewFeedback: undefined,
		}));
	});
});
