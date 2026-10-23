import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

const SummaryOutput = Type.Object({ summary: Type.String({ minLength: 1 }), title: Type.String() });
const Tab = Type.Object({ tab_id: Type.String(), workspace_id: Type.String(), label: Type.String() });
const TabInfo = Type.Object({ result: Type.Object({ tab: Tab }) });
const TabList = Type.Object({ result: Type.Object({ tabs: Type.Array(Tab) }) });

type HerdrContext = { readonly tabId: string; readonly workspaceId?: string };

export function getHerdrContext(): HerdrContext | undefined {
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_TAB_ID) return undefined;
	return { tabId: process.env.HERDR_TAB_ID, workspaceId: process.env.HERDR_WORKSPACE_ID };
}

export const HERDR_OUTPUT_INSTRUCTIONS = [
	"Return JSON only: {\"summary\": \"the one-line session summary\", \"title\": \"a separate meaningful Herdr tab title\"}.",
	"Keep the summary as requested above. Give the title at most four words, counting whitespace and hyphens as word separators.",
	"The title must capture the current problem, not merely truncate the summary. Do not add a prefix to the title.",
].join("\n");

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export function parseHerdrSummary(text: string): { readonly summary: string; readonly title: string } | undefined {
	const output = parseJson(text);
	if (!Check(SummaryOutput, output)) return undefined;
	return { summary: output.summary.trim(), title: output.title.trim().split(/[\s-]+/).filter(Boolean).slice(0, 4).join(" ") };
}

/** Re-read ownership immediately before renaming; removing [w] opts out. */
export async function renameHerdrTab(pi: Pick<ExtensionAPI, "exec">, context: HerdrContext, title: string): Promise<void> {
	if (!title) return;
	const run = (args: string[]) => pi.exec("herdr", ["tab", ...args], { timeout: 3000 });
	let workspaceId = context.workspaceId;
	if (!workspaceId) {
		const info = await run(["get", context.tabId]);
		if (info.code !== 0) return;
		const parsed = parseJson(info.stdout);
		if (!Check(TabInfo, parsed) || parsed.result.tab.tab_id !== context.tabId) return;
		workspaceId = parsed.result.tab.workspace_id;
	}
	const listed = await run(["list", "--workspace", workspaceId]);
	if (listed.code !== 0) return;
	const list = parseJson(listed.stdout);
	if (!Check(TabList, list)) return;
	const position = list.result.tabs.findIndex((tab) => tab.tab_id === context.tabId && tab.workspace_id === workspaceId) + 1;
	if (position === 0) return;
	const current = await run(["get", context.tabId]);
	if (current.code !== 0) return;
	const info = parseJson(current.stdout);
	if (!Check(TabInfo, info)) return;
	const tab = info.result.tab;
	if (tab.tab_id !== context.tabId || tab.workspace_id !== workspaceId) return;
	if (!tab.label.startsWith("[w]") && tab.label !== String(position)) return;
	await run(["rename", context.tabId, `[w] ${title}`]);
}
