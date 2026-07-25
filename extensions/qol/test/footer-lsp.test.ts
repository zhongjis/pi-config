import { describe, expect, it } from "vitest";

import { formatLspStatus } from "../../lsp/index.js";
import { styleInfraEntry } from "../src/footer.js";

// Theme stub that records the color applied so we can assert LSP is colorized.
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}`,
} as unknown as Parameters<typeof styleInfraEntry>[1];

function lspConfig(globalDisabled: boolean, servers: string[]) {
	return { globalDisabled, servers: servers.map((name) => ({ name })) } as never;
}

describe("qol footer — LSP infra styling", () => {
	it("hides LSP when there are 0 active servers", () => {
		expect(styleInfraEntry(formatLspStatus(null), theme)).toBeNull(); // "LSP none"
		expect(styleInfraEntry(formatLspStatus(lspConfig(true, ["tsserver"])), theme)).toBeNull(); // "LSP disabled"
		expect(styleInfraEntry(formatLspStatus(lspConfig(false, [])), theme)).toBeNull(); // "LSP none"
		expect(styleInfraEntry(formatLspStatus(lspConfig(false, ["a", "b", "c"]), 0), theme)).toBeNull(); // "LSP 0/3"
	});

	it("shows a colorized LSP without the 'running' phrase when servers are active", () => {
		const styled = styleInfraEntry(formatLspStatus(lspConfig(false, ["a", "b", "c"]), 2), theme);
		// lsp emits "LSP 2/3 running"; footer drops "running" and colorizes.
		expect(styled).toBe("<success>LSP 2/3");
		expect(styled).not.toContain("running");
	});

	it("passes non-LSP infra (MCP) through as muted", () => {
		const styled = styleInfraEntry("MCP: 2 servers", theme);
		expect(styled).toBe("<muted>MCP 2");
	});
});
