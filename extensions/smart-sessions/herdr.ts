import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { resolveHerdrAppTerminal } from "../lib/herdr-app.mjs";
import { detectPaneHost } from "../lib/pane-host.js";

const TerminalInfo = Type.Object({
	result: Type.Object({ terminal: Type.Object({ paneTitle: Type.Optional(Type.String()) }) }),
});
const SummaryOutput = Type.Object({ summary: Type.String({ minLength: 1 }), title: Type.String() });
const PaneInfo = Type.Object({
	result: Type.Object({ pane: Type.Object({ pane_id: Type.String(), label: Type.Optional(Type.String()) }) }),
});

type HerdrContext = { readonly paneId: string };

export function getHerdrContext(): HerdrContext | undefined {
	const paneId = process.env.HERDR_PANE_ID;
	return detectPaneHost() === "herdr" && paneId ? { paneId } : undefined;
}

type OrcaContext = { readonly handle: string };

export function getOrcaContext(): OrcaContext | undefined {
	const handle = process.env.ORCA_TERMINAL_HANDLE;
	return detectPaneHost() === "orca" && handle ? { handle } : undefined;
}

export type PaneContext =
	| { readonly host: "herdr-app"; readonly terminalId: string }
	| ({ readonly host: "herdr" } & HerdrContext)
	| ({ readonly host: "orca" } & OrcaContext);

/** The host pane to title, if the session runs inside Herdr or Orca. */
export function getPaneContext(): PaneContext | undefined {
	const terminalId = process.env.HC_TERMINAL_ID;
	if (detectPaneHost() === "herdr-app" && terminalId) return { host: "herdr-app", terminalId };
	const herdr = getHerdrContext();
	if (herdr) return { host: "herdr", ...herdr };
	const orca = getOrcaContext();
	return orca && { host: "orca", ...orca };
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
export type PaneClaim =
	| { readonly host: "herdr"; readonly paneId: string; readonly written: string }
	| { readonly host: "herdr-app"; readonly terminalId: string; readonly tabId: string; readonly written: string };

const isNumericTabName = (name: string) => /^[1-9]\d*$/.test(name);

async function readHerdrLabel(pi: Pick<ExtensionAPI, "exec">, paneId: string): Promise<{ label?: string } | undefined> {
	const current = await pi.exec("herdr", ["pane", "get", paneId], { timeout: 3000 });
	if (current.code !== 0) return undefined;
	const info = parseJson(current.stdout);
	return Check(PaneInfo, info) && info.result.pane.pane_id === paneId ? { label: info.result.pane.label } : undefined;
}

/** Re-read ownership immediately before renaming; a manual label opts out. */
export async function renameHerdrPane(pi: Pick<ExtensionAPI, "exec">, context: HerdrContext, title: string): Promise<PaneClaim | undefined> {
	if (!title) return undefined;
	const current = await readHerdrLabel(pi, context.paneId);
	if (!current || (current.label !== undefined && !current.label.startsWith("[w]"))) return undefined;
	const written = `[w] ${title}`;
	const result = await pi.exec("herdr", ["pane", "rename", context.paneId, written], { timeout: 3000 });
	return result.code === 0 ? { host: "herdr", paneId: context.paneId, written } : undefined;
}

/** Orca equivalent: `paneTitle` is present only when user- or tool-set, so absence means unlabelled. */
export async function renameOrcaPane(pi: Pick<ExtensionAPI, "exec">, context: OrcaContext, title: string): Promise<void> {
	if (!title) return;
	const run = (args: string[]) => pi.exec("orca", ["terminal", ...args], { timeout: 3000 });
	const current = await run(["show", "--terminal", context.handle, "--json"]);
	if (current.code !== 0) return;
	const info = parseJson(current.stdout);
	if (!Check(TerminalInfo, info)) return;
	const { paneTitle } = info.result.terminal;
	if (paneTitle !== undefined && !paneTitle.startsWith("[w]")) return;
	await run(["set-pane-title", "--terminal", context.handle, "--title", `[w] ${title}`]);
}

/** The app exposes tab names, not a pane-title API. Preserve manually named tabs. */
async function renameHerdrAppTab(pi: Pick<ExtensionAPI, "exec">, terminalId: string, title: string): Promise<PaneClaim | undefined> {
	if (!title) return undefined;
	const current = await resolveHerdrAppTerminal(pi.exec.bind(pi), terminalId);
	if (!current || (!isNumericTabName(current.tabName) && !current.tabName.startsWith("[w]"))) return undefined;
	const written = `[w] ${title}`;
	const result = await pi.exec("herdr-app", ["do", "tab.rename", "--id", current.tabId, "--name", written], { timeout: 3000 });
	return result.code === 0 ? { host: "herdr-app", terminalId, tabId: current.tabId, written } : undefined;
}

/** Orca titles are not claimed: its CLI has no verified way to clear a pane title. */
export async function renamePane(pi: Pick<ExtensionAPI, "exec">, context: PaneContext, title: string): Promise<PaneClaim | undefined> {
	switch (context.host) {
		case "herdr-app": return renameHerdrAppTab(pi, context.terminalId, title);
		case "herdr": return renameHerdrPane(pi, context, title);
		case "orca": await renameOrcaPane(pi, context, title); return undefined;
		default: { const exhaustive: never = context; return exhaustive; }
	}
}

/** Undo a claim only while the host still shows the title this process wrote. */
export async function restorePane(pi: Pick<ExtensionAPI, "exec">, claim: PaneClaim): Promise<void> {
	if (claim.host === "herdr") {
		const current = await readHerdrLabel(pi, claim.paneId);
		if (current?.label === claim.written) await pi.exec("herdr", ["pane", "rename", "--clear", claim.paneId], { timeout: 3000 });
		return;
	}
	// An empty name returns the tab to its positional number.
	const current = await resolveHerdrAppTerminal(pi.exec.bind(pi), claim.terminalId);
	if (current?.tabId === claim.tabId && current.tabName === claim.written) {
		await pi.exec("herdr-app", ["do", "tab.rename", "--id", claim.tabId, "--name", ""], { timeout: 3000 });
	}
}
