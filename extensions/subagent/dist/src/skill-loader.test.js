import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadSkills } from "./skill-loader.js";
let tempDir;
let homeDir;
let cwd;
beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-skills-"));
    homeDir = join(tempDir, "home");
    cwd = join(tempDir, "project");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("HOME", homeDir);
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
});
describe("preloadSkills", () => {
    it("loads Pi directory skills from ~/.pi/agent/skills", () => {
        const skillPath = join(homeDir, ".pi", "agent", "skills", "impeccable", "SKILL.md");
        mkdirSync(join(homeDir, ".pi", "agent", "skills", "impeccable"), { recursive: true });
        writeFileSync(skillPath, "# Impeccable\nLoaded from agent skills.\n");
        const [skill] = preloadSkills(["impeccable"], cwd);
        expect(skill).toEqual({
            name: "impeccable",
            content: "# Impeccable\nLoaded from agent skills.",
            sourcePath: skillPath,
            baseDir: join(homeDir, ".pi", "agent", "skills", "impeccable"),
        });
    });
    it("loads project .agents/skills directory skills from cwd ancestors", () => {
        const repoRoot = join(tempDir, "repo");
        const nestedCwd = join(repoRoot, "packages", "app");
        const skillPath = join(repoRoot, ".agents", "skills", "visual", "SKILL.md");
        mkdirSync(join(repoRoot, ".git"), { recursive: true });
        mkdirSync(join(repoRoot, ".agents", "skills", "visual"), { recursive: true });
        mkdirSync(nestedCwd, { recursive: true });
        writeFileSync(skillPath, "# Visual\nAncestor skill.\n");
        const [skill] = preloadSkills(["visual"], nestedCwd);
        expect(skill).toEqual({
            name: "visual",
            content: "# Visual\nAncestor skill.",
            sourcePath: skillPath,
            baseDir: join(repoRoot, ".agents", "skills", "visual"),
        });
    });
    it("prefers cwd .pi/skills over global skills", () => {
        const projectSkillPath = join(cwd, ".pi", "skills", "impeccable", "SKILL.md");
        const globalSkillPath = join(homeDir, ".pi", "agent", "skills", "impeccable", "SKILL.md");
        mkdirSync(join(cwd, ".pi", "skills", "impeccable"), { recursive: true });
        mkdirSync(join(homeDir, ".pi", "agent", "skills", "impeccable"), { recursive: true });
        writeFileSync(projectSkillPath, "project skill\n");
        writeFileSync(globalSkillPath, "global skill\n");
        const [skill] = preloadSkills(["impeccable"], cwd);
        expect(skill).toEqual({
            name: "impeccable",
            content: "project skill",
            sourcePath: projectSkillPath,
            baseDir: join(cwd, ".pi", "skills", "impeccable"),
        });
    });
    it("keeps legacy flat .pi/skills files working", () => {
        const skillPath = join(homeDir, ".pi", "skills", "legacy.md");
        mkdirSync(join(homeDir, ".pi", "skills"), { recursive: true });
        writeFileSync(skillPath, "legacy skill\n");
        const [skill] = preloadSkills(["legacy"], cwd);
        expect(skill).toEqual({
            name: "legacy",
            content: "legacy skill",
            sourcePath: skillPath,
            baseDir: join(homeDir, ".pi", "skills"),
        });
    });
    it("matches recursively discovered directory skills by frontmatter name", () => {
        const skillDir = join(homeDir, ".pi", "agent", "skills", "nested", "ui-polish");
        const skillPath = join(skillDir, "SKILL.md");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(skillPath, "---\nname: impeccable\ndescription: UI skill\n---\n# Impeccable nested\n");
        const [skill] = preloadSkills(["impeccable"], cwd);
        expect(skill).toEqual({
            name: "impeccable",
            content: "---\nname: impeccable\ndescription: UI skill\n---\n# Impeccable nested",
            sourcePath: skillPath,
            baseDir: skillDir,
        });
    });
    it("ignores root markdown files in .agents/skills like Pi does", () => {
        const skillPath = join(homeDir, ".agents", "skills", "visual.md");
        mkdirSync(join(homeDir, ".agents", "skills"), { recursive: true });
        writeFileSync(skillPath, "---\nname: visual\ndescription: Should not load\n---\n# Visual\n");
        const [skill] = preloadSkills(["visual"], cwd);
        expect(skill).toEqual({
            name: "visual",
            content: '(Skill "visual" not found in Pi skill locations)',
        });
    });
});
