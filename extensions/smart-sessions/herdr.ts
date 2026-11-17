import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { resolveHerdrAppTerminal } from "../lib/herdr-app.mjs";
import { detectPaneHost } from "../lib/pane-host.js";

const SummaryOutput = Type.Object({ summary: Type.String({ minLength: 1 }), title: Type.String() });
export type PaneContext = { readonly host: "herdr-app"; readonly terminalId: string };

/** The host title target, if the session runs inside herdr-app. */
export function getPaneContext(): PaneContext | undefined {
	const terminalId = process.env.HC_TERMINAL_ID;
	if (detectPaneHost() === "herdr-app" && terminalId) return { host: "herdr-app", terminalId };
	return undefined;
}

export const HERDR_OUTPUT_INSTRUCTIONS = [
	"Return JSON only: {\"summary\": \"the one-line session summary\", \"title\": \"a separate meaningful pane title\"}.",
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

/** A title this process wrote; restore only while the host still shows `written`. */
export type PaneClaim = { readonly host: "herdr-app"; readonly terminalId: string; readonly tabId: string; readonly written: string; readonly restore: string };

const isNumericTabName = (name: string) => /^[1-9]\d*$/.test(name);
// herdr-app's + menu names an agent's tab after the agent ("Pi"); that is a default, not a manual name.
const isAgentTabName = (name: string, app: string | undefined) => app !== undefined && name.toLowerCase() === app.toLowerCase();

/** The app exposes tab names, not a pane-title API. Preserve manually named tabs. */
export async function renamePane(pi: Pick<ExtensionAPI, "exec">, context: PaneContext, title: string, previous?: PaneClaim): Promise<PaneClaim | undefined> {
	const { terminalId } = context;
	if (!title) return undefined;
	const current = await resolveHerdrAppTerminal(pi.exec.bind(pi), terminalId);
	if (!current) return undefined;
	const agentName = isAgentTabName(current.tabName, current.app);
	if (!agentName && !isNumericTabName(current.tabName) && !current.tabName.startsWith("[w]")) return undefined;
	const written = `[w] ${title}`;
	const result = await pi.exec("herdr-app", ["do", "tab.rename", "--id", current.tabId, "--name", written], { timeout: 3000 });
	// An empty name returns the tab to its positional number; a re-rename keeps the first claim's target.
	const restore = previous?.tabId === current.tabId ? previous.restore : agentName ? current.tabName : "";
	return result.code === 0 ? { host: "herdr-app", terminalId, tabId: current.tabId, written, restore } : undefined;
}

/** Undo a claim only while the host still shows the title this process wrote. */
export async function restorePane(pi: Pick<ExtensionAPI, "exec">, claim: PaneClaim): Promise<void> {
	const current = await resolveHerdrAppTerminal(pi.exec.bind(pi), claim.terminalId);
	if (current?.tabId === claim.tabId && current.tabName === claim.written) {
		await pi.exec("herdr-app", ["do", "tab.rename", "--id", claim.tabId, "--name", claim.restore], { timeout: 3000 });
	}
}
