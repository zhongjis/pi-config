import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = join(process.cwd(), "extensions", "superpowers");
const skillsRoot = join(extensionRoot, "skills");

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

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function parseFrontmatter(content: string): Record<string, string> {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) return {};

  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) return {};

  const frontmatter: Record<string, string> = {};
  for (const line of normalized.slice(4, endIndex).split("\n")) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return frontmatter;
}

function listSkillDirs(): string[] {
  return readdirSync(skillsRoot)
    .filter((name) => statSync(join(skillsRoot, name)).isDirectory())
    .sort();
}

describe("superpowers package manifest", () => {
  it("declares extension entrypoint and upstream provenance", () => {
    const manifest = readJson(join(extensionRoot, "package.json"));

    expect(manifest.pi).toEqual({
      extensions: ["./index.ts"],
    });
    expect(manifest.piVendor).toMatchObject({
      upstream: "https://github.com/obra/superpowers",
      commit: "f2cbfbef",
      version: "5.1.0",
      localTarget: "extensions/superpowers",
    });
  });
});

describe("superpowers vendored skills", () => {
  it("vendors all expected upstream skill directories", () => {
    expect(listSkillDirs()).toEqual(expectedSkills);
  });

  for (const skillName of expectedSkills) {
    it(`${skillName} has valid frontmatter and provenance`, () => {
      const skillPath = join(skillsRoot, skillName, "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);

      const content = readText(skillPath);
      const frontmatter = parseFrontmatter(content);

      expect(frontmatter.name).toBe(skillName);
      expect(frontmatter.description).toBeTruthy();
      expect(content).toContain(`https://github.com/obra/superpowers/tree/main/skills/${skillName}`);
    });
  }

  it("adds a Pi-native tool mapping reference for using-superpowers", () => {
    expect(existsSync(join(skillsRoot, "using-superpowers", "references", "pi-tools.md"))).toBe(true);
  });
});

describe("superpowers patch audit", () => {
  it("does not advertise Weiping dispatch_agent as an available tool", () => {
    const allText = expectedSkills
      .map((skillName) => readText(join(skillsRoot, skillName, "SKILL.md")))
      .join("\n");

    expect(allText).not.toContain("dispatch_agent");
  });

  it("documents Pi replacements for Claude-only Task and TodoWrite references", () => {
    const mapping = readText(join(skillsRoot, "using-superpowers", "references", "pi-tools.md"));

    expect(mapping).toContain("`Task` tool");
    expect(mapping).toContain("`Agent`");
    expect(mapping).toContain("`TodoWrite`");
    expect(mapping).toContain("`TaskCreate`");
    expect(mapping).toContain("`TaskUpdate`");
  });
});
