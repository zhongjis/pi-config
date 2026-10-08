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

	it.each([
		{
			level: "lite",
			present: ["Active level: lite. LITE_ROW_ALPHA", "Examples (lite): LITE_EX_DELTA LITE_EX_CASE LITE_EX_HOTEL"],
			absent: [
				"FULL_ROW_BRAVO", "ULTRA_ROW_CHARLIE", "FULL_EX_ECHO", "ULTRA_EX_FOXTROT",
				"FULL_EX_INDIA", "ULTRA_EX_JULIET", "WENYAN_EX_GOLF", "WENYAN_EX_KILO", "wenyan",
			],
		},
		{
			level: "full",
			present: ["FULL_ROW_BRAVO", "Examples (full): FULL_EX_ECHO FULL_EX_INDIA"],
			absent: ["LITE_EX_DELTA", "WENYAN_EX_GOLF"],
		},
	] as const)("injects only the $level level row and examples", async ({ level, present, absent }) => {
		await writeSkill(TEST_SKILL_BODY);
		const prompt = await importFreshPrompt();

		const injected = prompt.buildInjectedPrompt(level);

		for (const token of present) expect(injected).toContain(token);
		for (const token of absent) expect(injected).not.toContain(token);
		expect(injected.indexOf("Rules:")).toBeLessThan(injected.indexOf(`Examples (${level}):`));
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
