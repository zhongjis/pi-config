import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestSession, type TestSession } from "./helpers/faux-session.js";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SUBAGENT_EXTENSION = path.resolve(PROJECT_ROOT, "extensions/subagents/src/index.ts");

const THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
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

function renderText(component: unknown, width = 120): string {
	if (component && typeof component === "object" && "render" in component && typeof component.render === "function") {
		return component.render(width).join("\n");
	}
	if (component && typeof component === "object" && "text" in component && typeof component.text === "string") {
		return component.text;
	}
	return String(component ?? "");
}

function getAgentTool(t: TestSession): { renderResult: (...args: any[]) => unknown } {
	const runnerTool = (t.session as SessionLike).extensionRunner?.getToolDefinition?.("agent");
	const tools = (t.session as SessionLike).agent?.state?.tools ?? [];
	const tool = runnerTool ?? tools.find((candidate) => candidate.name === "agent");
	if (!tool?.renderResult) throw new Error("agent tool renderer not registered");
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
			result: "Agent result body",
			...overrides,
		},
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
		const previousPackageDir = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = path.resolve(PROJECT_ROOT, "node_modules/@earendil-works/pi-coding-agent");
		try {
			initTheme(undefined, false);
		} finally {
			if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previousPackageDir;
		}
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

		expect(foreground).toContain("running · reading");
		expect(background).toContain("started in background");
		expect(background).toContain("id: bg-1");
		expect(completed).toContain("completed · Agent result body");
	});


	it("clips notification previews on native grapheme and terminal-cell boundaries", async () => {
		t = await createTestSession({ extensions: [SUBAGENT_EXTENSION], propagateErrors: false });
		const renderer = (t.session as SessionLike).extensionRunner?.getMessageRenderer("subagent-notification");
		if (!renderer) throw new Error("Notification renderer not registered");

		for (const grapheme of ["界", "🧩", "e\u0301"]) {
			const resultPreview = `${grapheme.repeat(100)}\nretained ending`;
			const message = Object.freeze({
				content: resultPreview,
				details: Object.freeze({
					id: "preview-1", description: "Workflow preview", status: "completed",
					toolUses: 0, turnCount: 0, totalTokens: 0, durationMs: 0, resultPreview,
				}),
			});
			const before = JSON.stringify(message);
			const collapsed = renderer(message, { expanded: false }, THEME);
			const expanded = renderer(message, { expanded: true }, THEME);
			const previewLine = renderText(collapsed, 80).split("\n").map(stripVTControlCharacters).find((line) => line.includes(grapheme));
			if (!previewLine) throw new TypeError("notification preview line was not rendered");
			const preview = previewLine.trim();
			expect(preview).toMatch(/…$/u);
			expect(visibleWidth(preview)).toBeLessThanOrEqual(80);
			expect(preview.slice(0, -1).split(grapheme).join("")).toBe("");
			const expandedLines = renderText(expanded, 500).split("\n").map((line) => stripVTControlCharacters(line).trim());
			expect(expandedLines).toContain(grapheme.repeat(100));
			expect(expandedLines).toContain("retained ending");
			for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
				for (const component of [collapsed, expanded]) {
					for (const line of renderText(component, width).split("\n")) {
						expect(visibleWidth(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
					}
				}
			}
			expect(JSON.stringify(message)).toBe(before);
		}
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
					id: "bg-1",
					description: "background one",
					status: "completed",
					resultPreview: "one done",
					toolUses: 1,
					turnCount: 1,
					totalTokens: 12,
					durationMs: 100,
					others: [
						{ id: "bg-2", description: "background two", status: "completed", resultPreview: "two done", toolUses: 2, turnCount: 2, totalTokens: 24, durationMs: 200 },
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
