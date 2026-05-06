import { describe, expect, it } from "vitest";
import { parseModeAgentConfig } from "../src/config-loader.js";
import { derivePlanTitleFromMarkdown } from "../src/plan-storage.js";

describe("parseModeAgentConfig", () => {
	it("parses migrated builtin and extension tool frontmatter", () => {
		const config = parseModeAgentConfig(`---
prompt_mode: replace
builtin_tools: read,write,edit
extension_tools: ask,Agent,readonly_bash
extensions: clauderock
allow_delegation_to: chengfeng,yanluo
disallow_delegation_to: houtu
allow_nesting: true
model: anthropic/claude-sonnet-4-6:medium
---

Mode prompt.`);

		expect(config).toMatchObject({
			body: "Mode prompt.",
			promptMode: "replace",
			builtinToolNames: ["read", "write", "edit"],
			extensionToolNames: ["ask", "Agent", "readonly_bash"],
			extensions: ["clauderock"],
			allowDelegationTo: ["chengfeng", "yanluo"],
			disallowDelegationTo: ["houtu"],
			allowNesting: true,
			model: "anthropic/claude-sonnet-4-6:medium",
		});
	});

	it("leaves tool policy unset when tool frontmatter is absent", () => {
		const config = parseModeAgentConfig(`---
prompt_mode: append
---

Prompt only.`);

		expect(config).toMatchObject({
			body: "Prompt only.",
			promptMode: "append",
		});
		expect(config?.builtinToolNames).toBeUndefined();
		expect(config?.extensionToolNames).toBeUndefined();
		expect(config?.extensions).toBeUndefined();
	});

	it("rejects obsolete tools frontmatter", () => {
		expect(parseModeAgentConfig(`---
tools: read,bash
---

Legacy prompt.`)).toBeNull();
	});
});

describe("derivePlanTitleFromMarkdown", () => {
	it("extracts H1 title from markdown", () => {
		expect(derivePlanTitleFromMarkdown("# My Plan\n\n- item 1")).toBe("My Plan");
	});

	it("returns undefined for no heading", () => {
		expect(derivePlanTitleFromMarkdown("No heading here\n\nJust text")).toBeUndefined();
	});

	it("handles heading with trailing hashes", () => {
		expect(derivePlanTitleFromMarkdown("# Title ##\n\nBody")).toBe("Title");
	});

	it("ignores H2 and deeper headings for title", () => {
		expect(derivePlanTitleFromMarkdown("## Subtitle\n\n- items")).toBeUndefined();
	});

	it("handles leading whitespace before heading", () => {
		expect(derivePlanTitleFromMarkdown("   # Indented Title\n\nBody")).toBe("Indented Title");
	});

	it("returns undefined for empty string", () => {
		expect(derivePlanTitleFromMarkdown("")).toBeUndefined();
	});
});
