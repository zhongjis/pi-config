import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preloadSkills } from "../src/skill-loader.js";

describe("preloadSkills", () => {
  let tmpDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-skill-test-"));
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, "user-agent-dir");
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const projectRoot = () => join(tmpDir, ".pi", "skills");
  const globalRoot = () => join(process.env.PI_CODING_AGENT_DIR!, "skills");

  function writeFlat(root: string, name: string, content: string, ext = ".md") {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, name + ext), content);
  }

  function writeSkillDir(root: string, name: string, content: string) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content);
  }

  it("returns empty array for empty skill list", () => {
    expect(preloadSkills([], tmpDir)).toEqual([]);
  });

  it("loads a top-level flat .md skill from project", () => {
    writeFlat(projectRoot(), "api-conventions", "# API Conventions");
    const result = preloadSkills(["api-conventions"], tmpDir);
    expect(result[0].content).toContain("API Conventions");
  });

  it("ignores .txt files (only .md is supported)", () => {
    writeFlat(projectRoot(), "error-handling", "should not load", ".txt");
    expect(preloadSkills(["error-handling"], tmpDir)[0].content).toContain("not found");
  });

  it("ignores extensionless files (only .md is supported)", () => {
    writeFlat(projectRoot(), "bare-skill", "should not load", "");
    expect(preloadSkills(["bare-skill"], tmpDir)[0].content).toContain("not found");
  });

  it("loads a top-level <name>/SKILL.md from project", () => {
    writeSkillDir(projectRoot(), "writing-go", "# Writing Go");
    expect(preloadSkills(["writing-go"], tmpDir)[0].content).toContain("Writing Go");
  });

  it("loads a top-level <name>/SKILL.md from getAgentDir()/skills", () => {
    writeSkillDir(globalRoot(), "writing-python", "# Writing Python");
    expect(preloadSkills(["writing-python"], tmpDir)[0].content).toContain("Writing Python");
  });

  it("loads a flat .md from getAgentDir()/skills", () => {
    writeFlat(globalRoot(), "shell-tips", "use rg");
    expect(preloadSkills(["shell-tips"], tmpDir)[0].content).toBe("use rg");
  });

  it("finds nested <subdir>/<name>/SKILL.md in getAgentDir()/skills", () => {
    writeSkillDir(join(globalRoot(), "dev-tools"), "using-modern-cli", "# Modern CLI");
    expect(preloadSkills(["using-modern-cli"], tmpDir)[0].content).toContain("Modern CLI");
  });

  it("loads <name>/SKILL.md from project .agents/skills (Agent Skills spec)", () => {
    writeSkillDir(join(tmpDir, ".agents", "skills"), "writing-rust", "# Writing Rust");
    expect(preloadSkills(["writing-rust"], tmpDir)[0].content).toContain("Writing Rust");
  });

  it("prefers .pi/skills over .agents/skills in the same project", () => {
    writeSkillDir(projectRoot(), "shared", "from-pi");
    writeSkillDir(join(tmpDir, ".agents", "skills"), "shared", "from-agents");
    expect(preloadSkills(["shared"], tmpDir)[0].content).toBe("from-pi");
  });

  it("finds nested <subdir>/<name>/SKILL.md", () => {
    writeSkillDir(join(projectRoot(), "dev-tools"), "using-modern-cli", "# Modern CLI");
    expect(preloadSkills(["using-modern-cli"], tmpDir)[0].content).toContain("Modern CLI");
  });

  it("prefers project over global", () => {
    writeSkillDir(projectRoot(), "shared", "from-project");
    writeSkillDir(globalRoot(), "shared", "from-global");
    expect(preloadSkills(["shared"], tmpDir)[0].content).toBe("from-project");
  });

  it("prefers shallower match (lex tie-break)", () => {
    // Different depths — shallower wins.
    writeSkillDir(join(projectRoot(), "z-deep", "nested"), "collide", "deep");
    writeSkillDir(join(projectRoot(), "a-shallow"), "collide", "shallow");
    expect(preloadSkills(["collide"], tmpDir)[0].content).toBe("shallow");

    // Same depth — alphabetical wins.
    writeSkillDir(join(projectRoot(), "b-sibling"), "tie", "b");
    writeSkillDir(join(projectRoot(), "a-sibling"), "tie", "a");
    expect(preloadSkills(["tie"], tmpDir)[0].content).toBe("a");
  });

  it("descends past a same-named dir that lacks SKILL.md to find a deeper match", () => {
    // .pi/skills/foo exists empty; .pi/skills/foo/inner/foo/SKILL.md is the real skill.
    mkdirSync(join(projectRoot(), "foo"), { recursive: true });
    writeSkillDir(join(projectRoot(), "foo", "inner"), "foo", "deeper");
    expect(preloadSkills(["foo"], tmpDir)[0].content).toBe("deeper");
  });

  it("does not descend into a sibling skill directory (skills don't nest)", () => {
    // .pi/skills/outer is itself a skill; .pi/skills/outer/target/SKILL.md must NOT be found.
    writeSkillDir(projectRoot(), "outer", "outer-skill");
    writeSkillDir(join(projectRoot(), "outer"), "target", "hidden");
    expect(preloadSkills(["target"], tmpDir)[0].content).toContain("not found");
  });

  it("skips node_modules during recursion", () => {
    writeSkillDir(join(projectRoot(), "node_modules", "some-pkg"), "leaked", "should not load");
    expect(preloadSkills(["leaked"], tmpDir)[0].content).toContain("not found");
  });

  it("skips dotfile directories during recursion", () => {
    writeSkillDir(join(projectRoot(), ".hidden-tree"), "buried", "should not load");
    expect(preloadSkills(["buried"], tmpDir)[0].content).toContain("not found");
  });

  it("returns fallback for missing skills", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].content).toContain("not found");
  });

  it("loads multiple skills", () => {
    writeFlat(projectRoot(), "a", "Content A");
    writeSkillDir(projectRoot(), "b", "Content B");
    const result = preloadSkills(["a", "b"], tmpDir);
    expect(result.map((r) => r.content)).toEqual(["Content A", expect.stringContaining("Content B")]);
  });

  it("skips skill names with path traversal (..)", () => {
    expect(preloadSkills(["../../etc/passwd"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names with forward slash", () => {
    expect(preloadSkills(["sub/dir"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names with backslash", () => {
    expect(preloadSkills(["sub\\dir"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names with spaces", () => {
    expect(preloadSkills(["my skill"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names starting with a dot", () => {
    expect(preloadSkills([".hidden"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips empty skill names", () => {
    expect(preloadSkills([""], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names exceeding 128 characters", () => {
    const longName = "a".repeat(129);
    expect(preloadSkills([longName], tmpDir)[0].content).toContain("path traversal");
  });

  it("loads valid skills alongside skipped unsafe ones", () => {
    writeFlat(projectRoot(), "legit", "Good content");
    const result = preloadSkills(["../evil", "legit"], tmpDir);
    expect(result[0].content).toContain("path traversal");
    expect(result[1].content).toBe("Good content");
  });

  it("loads symlinked flat .md files with logical metadata", () => {
    mkdirSync(projectRoot(), { recursive: true });
    const target = join(tmpDir, "installed-flat.md");
    writeFileSync(target, "Installed flat instructions");
    const sourcePath = join(projectRoot(), "linked-flat.md");
    symlinkSync(target, sourcePath);
    expect(preloadSkills(["linked-flat"], tmpDir)).toEqual([{
      name: "linked-flat", content: "Installed flat instructions", sourcePath, baseDir: projectRoot(),
    }]);
  });

  it("loads symlinked skill directories with logical metadata", () => {
    mkdirSync(globalRoot(), { recursive: true });
    writeSkillDir(tmpDir, "installed-skill", "Installed directory instructions");
    const baseDir = join(globalRoot(), "linked-dir");
    symlinkSync(join(tmpDir, "installed-skill"), baseDir);
    expect(preloadSkills(["linked-dir"], tmpDir)).toEqual([{
      name: "linked-dir", content: "Installed directory instructions", sourcePath: join(baseDir, "SKILL.md"), baseDir,
    }]);
  });

  it("loads flat and directory skills from a symlinked search root", () => {
    const realRoot = join(tmpDir, "installed-root");
    writeFlat(realRoot, "linked-root-flat", "Root flat instructions");
    writeSkillDir(realRoot, "linked-root-dir", "Root directory instructions");
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    symlinkSync(realRoot, projectRoot());
    expect(preloadSkills(["linked-root-flat", "linked-root-dir"], tmpDir)).toEqual([
      {
        name: "linked-root-flat", content: "Root flat instructions",
        sourcePath: join(projectRoot(), "linked-root-flat.md"), baseDir: projectRoot(),
      },
      {
        name: "linked-root-dir", content: "Root directory instructions",
        sourcePath: join(projectRoot(), "linked-root-dir", "SKILL.md"), baseDir: join(projectRoot(), "linked-root-dir"),
      },
    ]);
  });

  it("loads symlinked SKILL.md inside a real skill directory", () => {
    const baseDir = join(projectRoot(), "linked-inner");
    mkdirSync(baseDir, { recursive: true });
    const target = join(tmpDir, "installed-inner.md");
    writeFileSync(target, "Installed inner instructions");
    const sourcePath = join(baseDir, "SKILL.md");
    symlinkSync(target, sourcePath);
    expect(preloadSkills(["linked-inner"], tmpDir)).toEqual([{
      name: "linked-inner", content: "Installed inner instructions", sourcePath, baseDir,
    }]);
  });

  it("discovers frontmatter names through nested installed packages with logical metadata", () => {
    const installed = join(tmpDir, "installed-package");
    writeSkillDir(join(installed, "skills"), "physical-name", "---\nname: linked-package-skill\n---\nPackage instructions");
    mkdirSync(globalRoot(), { recursive: true });
    symlinkSync(installed, join(globalRoot(), "package"));
    const baseDir = join(globalRoot(), "package", "skills", "physical-name");
    expect(preloadSkills(["linked-package-skill"], tmpDir)).toEqual([{
      name: "linked-package-skill", content: "---\nname: linked-package-skill\n---\nPackage instructions",
      sourcePath: join(baseDir, "SKILL.md"), baseDir,
    }]);
  });

  it("prefers project skills over linked installed package skills", () => {
    const installed = join(tmpDir, "installed-package");
    writeSkillDir(join(installed, "skills"), "physical-name", "---\nname: linked-package-skill\n---\nPackage instructions");
    mkdirSync(globalRoot(), { recursive: true });
    symlinkSync(installed, join(globalRoot(), "package"));
    writeSkillDir(projectRoot(), "linked-package-skill", "Project instructions");
    expect(preloadSkills(["linked-package-skill"], tmpDir)[0].content).toBe("Project instructions");
  });

  it("keeps same-target directory aliases discoverable by their inferred names", () => {
    writeSkillDir(tmpDir, "installed-alias-target", "Shared alias instructions");
    mkdirSync(globalRoot(), { recursive: true });
    for (const name of ["linked-alias-a", "linked-alias-b"]) {
      symlinkSync(join(tmpDir, "installed-alias-target"), join(globalRoot(), name));
    }
    expect(preloadSkills(["linked-alias-a", "linked-alias-b"], tmpDir)).toEqual(
      ["linked-alias-a", "linked-alias-b"].map((name) => ({
        name, content: "Shared alias instructions", sourcePath: join(globalRoot(), name, "SKILL.md"), baseDir: join(globalRoot(), name),
      })),
    );
  });

  it.each(["self", "ancestor", "two-directory"])("skips %s cycles while delivering reachable skills", (cycle) => {
    const installed = join(tmpDir, "cycle-package");
    const branch = join(installed, "branch");
    mkdirSync(branch, { recursive: true });
    if (cycle === "two-directory") {
      const other = join(tmpDir, "other-package");
      writeSkillDir(other, "linked-cycle-skill", "Cycle-safe instructions");
      symlinkSync(other, join(branch, "next"));
      symlinkSync(installed, join(other, "back"));
    } else {
      writeSkillDir(branch, "linked-cycle-skill", "Cycle-safe instructions");
      symlinkSync(cycle === "self" ? branch : installed, join(branch, "back"));
    }
    mkdirSync(globalRoot(), { recursive: true });
    symlinkSync(installed, join(globalRoot(), "package"));
    expect(preloadSkills(["linked-cycle-skill", "linked-cycle-absent"], tmpDir).map((skill) => skill.content)).toEqual([
      "Cycle-safe instructions", '(Skill "linked-cycle-absent" not found in Pi skill locations)',
    ]);
  });

  it("ignores broken links and non-regular skill files without losing valid siblings", () => {
    mkdirSync(projectRoot(), { recursive: true });
    symlinkSync(join(tmpDir, "missing"), join(projectRoot(), "linked-broken.md"));
    symlinkSync(join(tmpDir, "missing-directory"), join(projectRoot(), "linked-broken-dir"));
    symlinkSync("/dev/null", join(projectRoot(), "linked-device.md"));
    const invalidSkill = join(projectRoot(), "linked-nonregular");
    mkdirSync(invalidSkill, { recursive: true });
    symlinkSync("/dev/null", join(invalidSkill, "SKILL.md"));
    mkdirSync(join(projectRoot(), "linked-directory.md"));
    writeFlat(projectRoot(), "linked-valid", "Valid sibling instructions");
    const missing = ["linked-broken", "linked-broken-dir", "linked-device", "linked-nonregular", "linked-directory"];
    expect(preloadSkills([...missing, "linked-valid"], tmpDir).map((skill) => skill.content)).toEqual([
      ...missing.map((name) => `(Skill "${name}" not found in Pi skill locations)`), "Valid sibling instructions",
    ]);
  });

});

describe("preloadSkills — frontmatter-name matching and metadata", () => {
  let tmpDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-skill-fm-test-"));
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, "user-agent-dir");
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const projectSkillsRoot = () => join(tmpDir, ".pi", "skills");

  function writeSkillDirWithFrontmatter(root: string, dirName: string, skillName: string, body: string) {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    const content = `---\nname: ${skillName}\n---\n${body}`;
    writeFileSync(join(dir, "SKILL.md"), content);
  }

  it("(RED→GREEN) finds a skill by frontmatter name: field even when dir name differs", () => {
    // Dir is "somedir" but frontmatter declares name: my-skill
    writeSkillDirWithFrontmatter(projectSkillsRoot(), "somedir", "my-skill", "# My Skill body");
    const result = preloadSkills(["my-skill"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-skill");
    expect(result[0].content).toContain("My Skill body");
  });

  it("(RED→GREEN) does NOT find the skill by dir name when frontmatter name differs", () => {
    // Dir is "somedir" but frontmatter declares name: my-skill
    writeSkillDirWithFrontmatter(projectSkillsRoot(), "somedir", "my-skill", "# My Skill body");
    // Searching by dir name should NOT find it
    const result = preloadSkills(["somedir"], tmpDir);
    expect(result[0].content).toContain("not found");
  });

  it("(RED→GREEN) returned PreloadedSkill has sourcePath and baseDir set", () => {
    writeSkillDirWithFrontmatter(projectSkillsRoot(), "somedir", "my-skill", "# My Skill");
    const result = preloadSkills(["my-skill"], tmpDir);
    expect(result[0].sourcePath).toBeDefined();
    expect(result[0].sourcePath).toContain("SKILL.md");
    expect(result[0].baseDir).toBeDefined();
    // baseDir should be the dir containing SKILL.md
    expect(result[0].baseDir).toContain("somedir");
  });

  it("(RED→GREEN) unknown skill name returns a not-found entry, not an empty array", () => {
    const result = preloadSkills(["totally-unknown-skill"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("totally-unknown-skill");
    expect(result[0].content).toContain("not found");
  });
});
