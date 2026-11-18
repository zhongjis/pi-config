import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
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

// Tab names are shared by every pane in a tab, so titles go on this terminal only (panda-focus `namer()` reads the label first).
const SESSION_LABEL = "pi.session";

/** Label this terminal `[w] <title>` (`[w]` tells people the name is agent-written); `false` when hc refused. */
export async function labelPane(pi: Pick<ExtensionAPI, "exec">, context: PaneContext, title: string): Promise<boolean> {
	if (!title) return false;
	return (await pi.exec("hc", ["label", context.terminalId, `${SESSION_LABEL}=[w] ${title}`], { timeout: 3000 })).code === 0;
}

export async function clearPaneLabel(pi: Pick<ExtensionAPI, "exec">, context: PaneContext): Promise<void> {
	await pi.exec("hc", ["label", context.terminalId, `${SESSION_LABEL}=`], { timeout: 3000 });
}
