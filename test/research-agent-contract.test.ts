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

	it("keeps recon agents on the GPT-5.6 medium fallback with omo attribution", () => {
		for (const path of ["agents/chengfeng.md", "agents/wenchang.md"]) {
			const prompt = repoFile(path);

			expect(prompt).toContain("openai-codex/gpt-5.6-terra:medium");
			expect(prompt).toContain("Adapted from omo");
		}
	});

	it("keeps implementation workers on the available GLM 5.2 fallback", () => {
		for (const path of ["agents/jintong.md", "agents/juling.md"]) {
			expect(repoFile(path)).toContain("opencode-go/glm-5.2");
		}
	});

	it("requires Kuafu to audit Wenchang citations before trusting research", () => {
		const prompt = repoFile("modes/kuafu/mode.md");

		expect(prompt).toContain("When using `wenchang`, audit the final answer before trusting it");
		expect(prompt).toContain("every cited URL MUST appear in its `Tool/source trace` as an opened source");
		expect(prompt).toContain("treat the research as failed");
	});
});
