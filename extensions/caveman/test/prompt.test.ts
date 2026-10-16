import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let originalHome: string | undefined;
let tempHome = "";

const TEST_SKILL_BODY = `# caveman

PRELUDE_ALPHA

## Persistence

PERSISTENCE_BRAVO

## Why

WHY_CHARLIE

## Rules

### 1. Answer first

RULES_DELTA

## When to break the rules

BREAK_ECHO

## Pre-send check

CHECK_FOXTROT`;

async function importFreshPrompt() {
	vi.resetModules();
	return import("../prompt.js");
}

async function writeSkill(name: string, body: string): Promise<string> {
	const path = join(tempHome, ".pi", "agent", "skills", name, "SKILL.md");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, body);
	return path;
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

	it.each([
		{ level: "full", skill: "caveman" },
		{ level: "ultra", skill: "ultracave" },
		{ level: "wenyan", skill: "megacave" },
	] as const)("reads the $skill skill for level $level", async ({ level, skill }) => {
		const path = await writeSkill(skill, `---\nname: ${skill}\ndescription: test\n---\n\n${TEST_SKILL_BODY}\n`);
		const prompt = await importFreshPrompt();

		expect(prompt.getPromptSourcePath(level)).toBe(path);
		expect(prompt.buildInjectedPrompt(level)).toContain("RULES_DELTA");
	});

	it("injects the skill body without frontmatter, title, or Persistence", async () => {
		await writeSkill("caveman", `---\nname: caveman\ndescription: FRONTMATTER_GOLF\n---\n\n${TEST_SKILL_BODY}\n`);
		const prompt = await importFreshPrompt();

		const injected = prompt.buildInjectedPrompt("full");

		expect(injected.startsWith("PRELUDE_ALPHA")).toBe(true);
		for (const token of ["WHY_CHARLIE", "### 1. Answer first", "RULES_DELTA", "## When to break the rules", "BREAK_ECHO", "CHECK_FOXTROT"]) {
			expect(injected).toContain(token);
		}
		for (const token of ["FRONTMATTER_GOLF", "# caveman", "Persistence", "PERSISTENCE_BRAVO"]) {
			expect(injected).not.toContain(token);
		}
	});

	it("throws when the level's skill is missing", async () => {
		const prompt = await importFreshPrompt();
		const expectedPath = join(tempHome, ".pi", "agent", "skills", "ultracave", "SKILL.md");

		expect(() => prompt.buildInjectedPrompt("ultra")).toThrow(`Caveman prompt source not found: ${expectedPath}`);
	});

	it("throws when a required section is missing", async () => {
		const path = await writeSkill("caveman", TEST_SKILL_BODY.replace("## When to break the rules", "## Auto-Clarity"));
		const prompt = await importFreshPrompt();

		expect(() => prompt.buildInjectedPrompt("full")).toThrow(
			`Caveman prompt source missing required section "When to break the rules": ${path}`,
		);
	});
});
