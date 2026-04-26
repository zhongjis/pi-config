import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { Mode, ModeConfig, ModePromptMode } from "./types.js";

function parseCsv(val: unknown): string[] | undefined {
	if (val === undefined || val === null) return undefined;
	const s = String(val).trim();
	if (!s || s.toLowerCase() === "none") return undefined;
	return s
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
}

function parseInheritField(val: unknown): true | false | string[] | undefined {
	if (val === undefined || val === null) return undefined;
	if (val === true) return true;
	if (val === false || val === "none") return false;
	const items = parseCsv(val);
	return items && items.length > 0 ? items : undefined;
}

export function loadAgentConfig(mode: Mode): ModeConfig | null {
	const globalPath = join(homedir(), ".pi", "agent", "agents", `${mode}.md`);

	if (!existsSync(globalPath)) return null;

	try {
		const content = readFileSync(globalPath, "utf-8");
		const { frontmatter, body } =
			parseFrontmatter<Record<string, unknown>>(content);
		const trimmedBody = body.trim();
		if (!trimmedBody) return null;

		const promptMode = frontmatter.prompt_mode === "replace" || frontmatter.prompt_mode === "append"
			? (frontmatter.prompt_mode as ModePromptMode)
			: undefined;

		return {
			body: trimmedBody,
			promptMode,
			tools: parseCsv(frontmatter.tools),
			extensions: parseInheritField(frontmatter.extensions),
			disallowedTools: parseCsv(frontmatter.disallowed_tools),
			allowDelegationTo: parseCsv(frontmatter.allow_delegation_to),
			disallowDelegationTo: parseCsv(frontmatter.disallow_delegation_to),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		};
	} catch {
		return null;
	}
}
