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
| **lite** | LITE_ROW_ALPHA |
| **full** | FULL_ROW_BRAVO |
| **ultra** | ULTRA_ROW_CHARLIE |

Example one
- lite: LITE_EX_DELTA
- wenyan-lite: WENYAN_EX_GOLF
- LITE: LITE_EX_CASE
- full: FULL_EX_ECHO
- ultra: ULTRA_EX_FOXTROT

Example two
- lite: LITE_EX_HOTEL
- full: FULL_EX_INDIA
- ultra: ULTRA_EX_JULIET
- wenyan-full: WENYAN_EX_KILO

## Auto-Clarity

clarity

## Boundaries

boundaries`;

async function importFreshPrompt() {
	vi.resetModules();
	return import("../prompt.js");
}

async function writeSkill(body: string): Promise<string> {
	const globalPath = join(tempHome, ".pi", "agent", "skills", "caveman", "SKILL.md");
	await mkdir(dirname(globalPath), { recursive: true });
	await writeFile(globalPath, body);
	return globalPath;
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
		const globalPath = await writeSkill(`---\nname: caveman\ndescription: test\n---\n\n${TEST_SKILL_BODY}\n`);

		const prompt = await importFreshPrompt();
		const source = prompt.loadPromptSource();
		const runtime = prompt.loadRuntimePrompt();

		expect(prompt.getPromptSourcePath()).toBe(globalPath);
		expect(source.raw.startsWith("---\n")).toBe(true);
		expect(source.prelude.startsWith("---")).toBe(false);
		expect(runtime.fragments.prelude.startsWith("---")).toBe(false);
		expect(Object.keys(source.sections)).toEqual(["Rules", "Intensity", "Auto-Clarity", "Boundaries"]);
	});

	it("throws when the global skill is missing", async () => {
		const prompt = await importFreshPrompt();
		const expectedPath = join(tempHome, ".pi", "agent", "skills", "caveman", "SKILL.md");

		expect(prompt.getPromptSourcePath()).toBe(expectedPath);
		expect(() => prompt.loadPromptSource()).toThrow(`Caveman prompt source not found: ${expectedPath}`);
		expect(() => prompt.loadRuntimePrompt()).toThrow(`Caveman prompt source not found: ${expectedPath}`);
	});

	it("injects only the active level row and examples", async () => {
		await writeSkill(TEST_SKILL_BODY);
		const prompt = await importFreshPrompt();
		const injected = prompt.buildInjectedPrompt("lite");

		expect(injected).toContain("Active level: lite. LITE_ROW_ALPHA");
		expect(injected).toContain("Active level overrides Rules where they conflict.");
		expect(injected).toContain("Examples (lite): LITE_EX_DELTA LITE_EX_CASE LITE_EX_HOTEL");
		expect(injected.indexOf("Active level: lite.")).toBeLessThan(
			injected.indexOf("Active level overrides Rules where they conflict."),
		);
		expect(injected.indexOf("Rules:")).toBeLessThan(injected.indexOf("Examples (lite):"));
		expect(injected).not.toContain("FULL_ROW_BRAVO");
		expect(injected).not.toContain("ULTRA_ROW_CHARLIE");
		expect(injected).not.toContain("FULL_EX_ECHO");
		expect(injected).not.toContain("ULTRA_EX_FOXTROT");
		expect(injected).not.toContain("FULL_EX_INDIA");
		expect(injected).not.toContain("ULTRA_EX_JULIET");
		expect(injected).not.toContain("WENYAN_EX_GOLF");
		expect(injected).not.toContain("WENYAN_EX_KILO");
		expect(injected).not.toContain("wenyan");

		const full = prompt.buildInjectedPrompt("full");
		expect(full).toContain("FULL_ROW_BRAVO");
		expect(full).toContain("Examples (full): FULL_EX_ECHO FULL_EX_INDIA");
		expect(full).not.toContain("LITE_EX_DELTA");
		expect(full).not.toContain("WENYAN_EX_GOLF");
	});

	it("omits the examples line when the active level has none", async () => {
		await writeSkill(TEST_SKILL_BODY.replace(/^- lite:.*\n/gim, ""));
		const prompt = await importFreshPrompt();

		const injected = prompt.buildInjectedPrompt("lite");

		expect(injected).toContain("LITE_ROW_ALPHA");
		expect(injected).not.toContain("Examples (");
		expect(injected).not.toContain("LITE_EX_DELTA");
		expect(injected).not.toContain("LITE_EX_CASE");
	});

	it("trims text before an Example block even when Example starts the section", async () => {
		const { beforeExampleBlock } = await importFreshPrompt();

		expect(beforeExampleBlock("Example: keep out\n\nUseful detail")).toBe("");
		expect(beforeExampleBlock("Keep this\n\nExample: keep out")).toBe("Keep this");
	});
});
