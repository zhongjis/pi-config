import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const lubanRoot = join(process.cwd(), "modes", "luban");
const skillsRoot = join(lubanRoot, "skills");

const expectedSkills = [
	"brainstorming",
	"dispatching-parallel-agents",
	"executing-plans",
	"finishing-a-development-branch",
	"receiving-code-review",
	"requesting-code-review",
	"subagent-driven-development",
	"systematic-debugging",
	"test-driven-development",
	"using-git-worktrees",
	"using-superpowers",
	"verification-before-completion",
	"writing-plans",
	"writing-skills",
];

const expectedSupportAssets = [
	"brainstorming/scripts/frame-template.html",
	"brainstorming/scripts/helper.js",
	"brainstorming/scripts/server.cjs",
	"brainstorming/scripts/start-server.sh",
	"brainstorming/scripts/stop-server.sh",
	"brainstorming/spec-document-reviewer-prompt.md",
	"brainstorming/visual-companion.md",
	"requesting-code-review/code-reviewer.md",
	"subagent-driven-development/implementer-prompt.md",
	"subagent-driven-development/scripts/review-package",
	"subagent-driven-development/scripts/sdd-workspace",
	"subagent-driven-development/scripts/task-brief",
	"subagent-driven-development/task-reviewer-prompt.md",
	"systematic-debugging/CREATION-LOG.md",
	"systematic-debugging/condition-based-waiting-example.ts",
	"systematic-debugging/condition-based-waiting.md",
	"systematic-debugging/defense-in-depth.md",
	"systematic-debugging/find-polluter.sh",
	"systematic-debugging/root-cause-tracing.md",
	"systematic-debugging/test-academic.md",
	"systematic-debugging/test-pressure-1.md",
	"systematic-debugging/test-pressure-2.md",
	"systematic-debugging/test-pressure-3.md",
	"test-driven-development/testing-anti-patterns.md",
	"using-superpowers/references/antigravity-tools.md",
	"using-superpowers/references/codex-tools.md",
	"writing-plans/plan-document-reviewer-prompt.md",
	"writing-skills/anthropic-best-practices.md",
	"writing-skills/examples/CLAUDE_MD_TESTING.md",
	"writing-skills/graphviz-conventions.dot",
	"writing-skills/persuasion-principles.md",
	"writing-skills/render-graphs.js",
	"writing-skills/testing-skills-with-subagents.md",
];

const expectedExecutableAssets = [
	"brainstorming/scripts/start-server.sh",
	"brainstorming/scripts/stop-server.sh",
	"subagent-driven-development/scripts/review-package",
	"subagent-driven-development/scripts/sdd-workspace",
	"subagent-driven-development/scripts/task-brief",
	"systematic-debugging/find-polluter.sh",
	"writing-skills/render-graphs.js",
];

function listFiles(root: string, base = root): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path, base));
		else if (entry.isFile()) files.push(relative(base, path));
	}
	return files.sort();
}

function listSkillDirs(): string[] {
	if (!existsSync(skillsRoot)) return [];
	return readdirSync(skillsRoot)
		.filter((name) => statSync(join(skillsRoot, name)).isDirectory())
		.sort();
}

describe("Luban mode-owned skills", () => {
	it("contains exactly the 14 approved skill directories", () => {
		expect(listSkillDirs()).toEqual(expectedSkills);
	});

	it("retains the complete approved support asset tree", () => {
		const supportAssets = listFiles(skillsRoot).filter((path) => !path.endsWith("/SKILL.md"));
		expect(supportAssets).toEqual(expectedSupportAssets);
	});

	it("preserves executable helper scripts", () => {
		for (const asset of expectedExecutableAssets) {
			expect(statSync(join(skillsRoot, asset)).mode & 0o111, asset).not.toBe(0);
		}
	});

	it("does not retain Pi mapping, overlay, extension, or package files", () => {
		const files = listFiles(lubanRoot);
		expect(files.some((path) => path.endsWith("pi-tools.md"))).toBe(false);
		expect(existsSync(join(lubanRoot, "overlay"))).toBe(false);
		expect(existsSync(join(lubanRoot, "index.ts"))).toBe(false);
		expect(existsSync(join(lubanRoot, "package.json"))).toBe(false);
	});
});
