import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let originalHome: string | undefined;
let tempHome = "";

const TEST_SKILL_BODY = `Runtime prelude.

## Rules

rules

## Intensity

| Level | What change |
|-------|-------------|
| **lite** | lite |
| **full** | full |
| **ultra** | ultra |

## Auto-Clarity

clarity

## Boundaries

boundaries`;

async function importFreshPrompt() {
	vi.resetModules();
	return import("../prompt.js");
}

describe("caveman prompt", () => {
	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await mkdtemp(join(tmpdir(), "caveman-prompt-home-"));
		process.env.HOME = tempHome;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		await rm(tempHome, { force: true, recursive: true });
	});

	it("prefers the global skill and strips its YAML frontmatter before parsing", async () => {
		const globalPath = join(tempHome, ".pi", "agent", "skills", "caveman", "SKILL.md");
		await mkdir(dirname(globalPath), { recursive: true });
		await writeFile(globalPath, `---\nname: caveman\ndescription: test\n---\n\n${TEST_SKILL_BODY}\n`);

		const prompt = await importFreshPrompt();
		const source = prompt.loadPromptSource();
		const runtime = prompt.loadRuntimePrompt();

		expect(prompt.getPromptSourcePath()).toBe(globalPath);
		expect(source.raw.startsWith("---\n")).toBe(true);
		expect(source.prelude.startsWith("---")).toBe(false);
		expect(runtime.fragments.prelude.startsWith("---")).toBe(false);
		expect(Object.keys(source.sections)).toEqual(["Rules", "Intensity", "Auto-Clarity", "Boundaries"]);
	});

	it("falls back to the bundled skill when the global skill is absent", async () => {
		const prompt = await importFreshPrompt();

		expect(prompt.getPromptSourcePath()).toBe(new URL("../upstream-caveman.SKILL.md", import.meta.url).pathname);
		expect(prompt.loadPromptSource().sections.Rules.length).toBeGreaterThan(0);
	});

	it("trims text before an Example block even when Example starts the section", async () => {
		const { beforeExampleBlock } = await importFreshPrompt();

		expect(beforeExampleBlock("Example: keep out\n\nUseful detail")).toBe("");
		expect(beforeExampleBlock("Keep this\n\nExample: keep out")).toBe("Keep this");
	});
});
