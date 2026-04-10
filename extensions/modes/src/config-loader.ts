import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { Mode, ModeConfig } from "./types.js";
import { parseCsv, parseInheritField } from "./utils.js";

export function loadAgentConfig(mode: Mode): ModeConfig | null {
	const globalPath = join(homedir(), ".pi", "agent", "agents", `${mode}.md`);

	if (!existsSync(globalPath)) return null;

	try {
		const content = readFileSync(globalPath, "utf-8");
		const { frontmatter, body } =
			parseFrontmatter<Record<string, unknown>>(content);
		const trimmedBody = body.trim();
		if (!trimmedBody) return null;

		return {
			body: trimmedBody,
			tools: parseCsv(frontmatter.tools),
			extensions:
				parseInheritField(frontmatter.extensions) ??
				(frontmatter.extensions === true ? true : undefined),
			disallowedTools: parseCsv(frontmatter.disallowed_tools),
			allowDelegationTo: parseCsv(frontmatter.allow_delegation_to),
			disallowDelegationTo: parseCsv(frontmatter.disallow_delegation_to),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		};
	} catch {
		return null;
	}
}
