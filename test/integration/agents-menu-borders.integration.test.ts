import { initTheme } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// Load extension source by path, as the other integration tests do, so the root
// test tsconfig does not type-check the subagents extension.
const SUBAGENTS_SRC = path.resolve(__dirname, "../../extensions/subagents/src");
const load = (file: string) => import(path.join(SUBAGENTS_SRC, file));

type CustomFactory = (...args: unknown[]) => { render(width: number): string[] };

const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

/** Render the first `ctx.ui.custom` component a menu opens; `select` answers with `pick`. */
function capturingUi(pick: (title: string, options: string[]) => string | undefined) {
	let lines: string[] | undefined;
	const ui = {
		notify: () => {},
		select: async (title: string, options: string[]) => (lines ? undefined : pick(title, options)),
		custom: async (factory: CustomFactory) => {
			lines ??= factory({ requestRender: () => {} }, THEME, {}, () => {}).render(60).map((line) => stripVTControlCharacters(line));
			return undefined;
		},
	};
	return { ui, lines: () => lines ?? [] };
}

function expectFramed(lines: string[]): void {
	expect(lines[0]).toMatch(/^─+$/);
	expect(lines.at(-1)).toMatch(/^─+$/);
}

describe("/agents second-level views", () => {
	beforeAll(() => initTheme(undefined, false));
	afterEach(async () => (await load("agent-types.ts")).registerAgents(new Map()));

	it("frames the Agent types list with top and bottom borders", async () => {
		const { registerAgents } = await load("agent-types.ts");
		const { AgentManager } = await load("agent-manager.ts");
		const { createAgentsMenu } = await load("ui/agents-menu.ts");
		registerAgents(new Map([["probe", {
			name: "probe",
			description: "probe",
			extensionRules: [],
			toolRules: [],
			discoverSkills: true,
			preloadSkills: [],
			systemPrompt: "Probe.",
			promptMode: "replace",
		}]]));
		const { ui, lines } = capturingUi((title, options) => (title === "Agents" ? options.find((o) => o.startsWith("Agent types")) : undefined));
		const menu = createAgentsMenu(
			{ pi: { getAllTools: () => [] }, manager: new AgentManager(), reloadCustomAgents: () => {} },
			new Map(),
			{
				graphRuns: { tasks: new Map(), getRecord: () => undefined, viewAgentConversation: async () => {}, getCtx: () => undefined },
				showSettings: async () => {},
			},
		);

		await menu.showAgentsMenu({ ui });

		expectFramed(lines());
	});

	it("frames the Settings list with top and bottom borders", async () => {
		const { createSettingsMenu } = await load("ui/settings-menu.ts");
		const settings = {
			maxConcurrent: 4,
			maxConcurrentForeground: 4,
			reportUsage: true,
			showCost: true,
			graphRuntimeTrace: true,
			decisionGateMinConfidence: 0.8,
			defaultJoinMode: "smart",
			scopeModels: false,
			toolDescriptionMode: "full",
			outputTranscript: true,
		};
		const { ui, lines } = capturingUi(() => undefined);

		await createSettingsMenu(() => settings, () => {})({ ui });

		expectFramed(lines());
	});
});
