import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestSession, type TestSession } from "@marcfargas/pi-test-harness";
import * as path from "node:path";
import { AgentWidget, type AgentActivity, type UICtx } from "../../extensions/subagent/src/ui/agent-widget.js";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SUBAGENT_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/subagent/index.ts");

const THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

interface AgentToolDefinitionLike {
	name?: string;
	renderResult?: (...args: any[]) => unknown;
}

interface ExtensionRunnerLike {
	hasHandlers(event: "session_shutdown"): boolean;
	emit(event: { type: "session_shutdown" }): Promise<void> | void;
	getMessageRenderer(customType: string): ((message: { details?: unknown }, options: { expanded: boolean }, theme: typeof THEME) => unknown) | undefined;
	getToolDefinition?(toolName: string): AgentToolDefinitionLike | undefined;
}

interface SessionLike {
	extensionRunner?: ExtensionRunnerLike;
	agent?: { state?: { tools?: AgentToolDefinitionLike[] } };
}

async function shutdownSession(session: SessionLike | undefined): Promise<void> {
	try {
		const runner = session?.extensionRunner;
		if (runner?.hasHandlers("session_shutdown")) {
			await runner.emit({ type: "session_shutdown" });
		}
	} catch (error) {
		void error;
	}
}

function renderText(component: unknown): string {
	if (component && typeof component === "object" && "render" in component && typeof component.render === "function") {
		return component.render().join("\n");
	}
	if (component && typeof component === "object" && "text" in component && typeof component.text === "string") {
		return component.text;
	}
	return String(component ?? "");
}

function getAgentTool(t: TestSession): { renderResult: (...args: any[]) => unknown } {
	const runnerTool = (t.session as SessionLike).extensionRunner?.getToolDefinition?.("Agent");
	const tools = (t.session as SessionLike).agent?.state?.tools ?? [];
	const tool = runnerTool ?? tools.find((candidate) => candidate.name === "Agent");
	if (!tool?.renderResult) throw new Error("Agent tool renderer not registered");
	return tool as { renderResult: (...args: any[]) => unknown };
}

function agentResult(status: string, overrides: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: "Agent result body" }],
		details: {
			displayName: "Agent",
			description: "render probe",
			subagentType: "general-purpose",
			toolUses: 1,
			tokens: "󰾆 42",
			durationMs: 125,
			status,
			...overrides,
		},
	};
}

function makeActivity(toolName: string): AgentActivity {
	return {
		activeTools: new Map([[`${toolName}-1`, toolName]]),
		toolUses: 1,
		tokens: "󰾆 42",
		responseText: "",
		turnCount: 1,
		maxTurns: 3,
		lastProgressAt: 0,
	};
}

describe("subagent TUI rendering — integration", () => {
	let t: TestSession | undefined;

	afterEach(async () => {
		vi.useRealTimers();
		await shutdownSession(t?.session as SessionLike | undefined);
		t?.dispose();
		t = undefined;
	});

	it("loads the real extension and renders mixed foreground/background Agent states", async () => {
		t = await createTestSession({
			extensions: [SUBAGENT_EXTENSION],
			propagateErrors: false,
		});

		const agentTool = getAgentTool(t);
		const foreground = renderText(agentTool.renderResult(
			agentResult("running", { description: "foreground probe", activity: "reading…", spinnerFrame: 0 }),
			{ expanded: false, isPartial: true },
			THEME,
			{ state: {} },
		));
		const background = renderText(agentTool.renderResult(
			agentResult("background", { description: "background probe", agentId: "bg-1" }),
			{ expanded: false, isPartial: false },
			THEME,
			{ state: {} },
		));
		const completed = renderText(agentTool.renderResult(
			agentResult("completed", { description: "completed probe" }),
			{ expanded: false, isPartial: false },
			THEME,
			{ state: {} },
		));

		expect(foreground).toContain("status: running");
		expect(foreground).toContain("activity: reading");
		expect(background).toContain("status: started");
		expect(background).toContain("agent: bg-1");
		expect(completed).toContain("status: completed");
		expect(completed).toContain("result: Agent result body");
	});

	it("keeps widget registration and status churn bounded during a mixed burst", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const records = [
			{ id: "fg-1", type: "general-purpose", status: "running", description: "foreground probe", toolUses: 1, startedAt: 0 },
			{ id: "bg-1", type: "general-purpose", status: "running", description: "background probe", toolUses: 1, startedAt: 0 },
			{ id: "bg-2", type: "general-purpose", status: "queued", description: "queued probe", toolUses: 0, startedAt: 0 },
		];
		const manager = { listAgents: vi.fn(() => records) };
		const activity = new Map<string, AgentActivity>([
			["fg-1", makeActivity("read")],
			["bg-1", makeActivity("bash")],
		]);
		const widget = new AgentWidget(manager as never, activity);
		const uiCtx = {
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		} satisfies UICtx;

		widget.setUICtx(uiCtx);
		widget.update();

		const widgetFactory = uiCtx.setWidget.mock.calls[0]?.[1];
		expect(typeof widgetFactory).toBe("function");
		const tui = { terminal: { columns: 120 }, requestRender: vi.fn() };
		const rendered = widgetFactory(tui, THEME).render().join("\n");
		expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "2 running, 1 queued agents");
		expect(rendered).toContain("foreground probe");
		expect(rendered).toContain("background probe");
		expect(rendered).toContain("1 queued");

		for (let i = 0; i < 5; i++) widget.update();
		expect(uiCtx.setWidget.mock.calls.filter((call) => call[0] === "agents" && typeof call[1] === "function")).toHaveLength(1);
		expect(uiCtx.setStatus).toHaveBeenCalledTimes(1);
		expect(tui.requestRender).not.toHaveBeenCalled();

		vi.advanceTimersByTime(250);
		widget.update();
		expect(tui.requestRender).toHaveBeenCalledTimes(1);

		activity.get("bg-1")!.toolUses = 2;
		widget.update();
		expect(tui.requestRender).toHaveBeenCalledTimes(2);
		expect(uiCtx.setWidget.mock.calls.filter((call) => call[0] === "agents" && typeof call[1] === "function")).toHaveLength(1);

		widget.dispose();
	});

	it("renders grouped completion notifications as one grouped surface", async () => {
		t = await createTestSession({
			extensions: [SUBAGENT_EXTENSION],
			propagateErrors: false,
		});

		const renderer = (t.session as SessionLike).extensionRunner?.getMessageRenderer("subagent-notification");
		expect(renderer).toBeDefined();

		const grouped = renderText(renderer!(
			{
				details: {
					description: "background one",
					status: "completed",
					resultPreview: "one done",
					toolUses: 1,
					totalTokens: 12,
					durationMs: 100,
					others: [
						{ description: "background two", status: "completed", resultPreview: "two done", toolUses: 2, totalTokens: 24, durationMs: 200 },
					],
				},
			},
			{ expanded: false },
			THEME,
		));

		expect(grouped).toContain("background one");
		expect(grouped).toContain("background two");
		expect(grouped).toContain("one done");
		expect(grouped).toContain("two done");
		expect(grouped.match(/✓/g)?.length).toBe(2);
	});
});
