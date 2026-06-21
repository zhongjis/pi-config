import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function repoFile(path: string): string {
	return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("research agent prompt contract", () => {
	it("requires Wenchang to cite only opened sources", () => {
		const prompt = repoFile("agents/wenchang.md");

		expect(prompt).toContain("MUST NOT delegate");
		expect(prompt).toContain("`web_search` is discovery only");
		expect(prompt).toContain("Treat snippets as leads");
		expect(prompt).toContain("MUST NOT cite URLs found in memory, snippets, search-result titles");
		expect(prompt).toContain("Research unavailable:");
		expect(prompt).toContain("Tool/source trace:");
		expect(prompt).toContain("Every URL in `Sources:` MUST appear here as an opened source");
	});

	it("requires Kuafu to audit Wenchang citations before trusting research", () => {
		const prompt = repoFile("modes/kuafu/mode.md");

		expect(prompt).toContain("When using `wenchang`, audit the final answer before trusting it");
		expect(prompt).toContain("every cited URL MUST appear in its `Tool/source trace` as an opened source");
		expect(prompt).toContain("treat the research as failed");
	});
});
