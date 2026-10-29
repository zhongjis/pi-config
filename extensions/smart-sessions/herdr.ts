import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

const SummaryOutput = Type.Object({ summary: Type.String({ minLength: 1 }), title: Type.String() });
const PaneInfo = Type.Object({
	result: Type.Object({ pane: Type.Object({ pane_id: Type.String(), label: Type.Optional(Type.String()) }) }),
});

type HerdrContext = { readonly paneId: string };

export function getHerdrContext(): HerdrContext | undefined {
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return undefined;
	return { paneId: process.env.HERDR_PANE_ID };
}

export const HERDR_OUTPUT_INSTRUCTIONS = [
	"Return JSON only: {\"summary\": \"the one-line session summary\", \"title\": \"a separate meaningful Herdr pane title\"}.",
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

/** Re-read ownership immediately before renaming; a manual label opts out. */
export async function renameHerdrPane(pi: Pick<ExtensionAPI, "exec">, context: HerdrContext, title: string): Promise<void> {
	if (!title) return;
	const run = (args: string[]) => pi.exec("herdr", ["pane", ...args], { timeout: 3000 });
	const current = await run(["get", context.paneId]);
	if (current.code !== 0) return;
	const info = parseJson(current.stdout);
	if (!Check(PaneInfo, info) || info.result.pane.pane_id !== context.paneId) return;
	const { label } = info.result.pane;
	if (label !== undefined && !label.startsWith("[w]")) return;
	await run(["rename", context.paneId, `[w] ${title}`]);
}
