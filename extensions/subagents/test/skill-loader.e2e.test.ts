import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preloadSkills } from "../src/skill-loader.js";
import { hermeticDir } from "./helpers/boot-extension.js";

// Real SDK parser: root unit aliases intentionally provide only a YAML subset.
describe("skill YAML identity (real SDK)", () => {
  it.each([
    "description: |\n  name: wrong",
    "metadata:\n  name: wrong",
  ])("ignores nested name fields in %s", (frontmatter) => {
    const fixture = hermeticDir();
    try {
      mkdirSync(join(fixture.dir, ".git"));
      const skillDir = join(fixture.dir, ".pi", "skills", "fallback");
      mkdirSync(skillDir, { recursive: true });
      const sourcePath = join(skillDir, "SKILL.md");
      writeFileSync(sourcePath, `---\n${frontmatter}\n---\nFALLBACK_PAYLOAD`);
      expect(preloadSkills(["fallback"], fixture.dir)[0]).toMatchObject({ sourcePath, baseDir: skillDir });
      expect(preloadSkills(["wrong"], fixture.dir)[0]).not.toHaveProperty("sourcePath");
    } finally {
      fixture.restore();
    }
  });

  it.each(['"canoni\\u0063al"', "'canonical' # alias", '"canonical" # alias'])("decodes top-level YAML name %s in flat skills", (yamlName) => {
    const fixture = hermeticDir();
    try {
      mkdirSync(join(fixture.dir, ".git"));
      const root = join(fixture.dir, ".pi", "skills");
      mkdirSync(root, { recursive: true });
      const sourcePath = join(root, "vendored.md");
      writeFileSync(sourcePath, `---\r\nname: ${yamlName}\r\n---\r\nESCAPED_PAYLOAD`);
      expect(preloadSkills(["canonical"], fixture.dir)[0]).toMatchObject({ sourcePath, baseDir: root });
      expect(preloadSkills(["vendored"], fixture.dir)[0]).not.toHaveProperty("sourcePath");
    } finally {
      fixture.restore();
    }
  });

  it("skips malformed YAML without blocking other optional preloads", () => {
    const fixture = hermeticDir();
    try {
      mkdirSync(join(fixture.dir, ".git"));
      const root = join(fixture.dir, ".pi", "skills");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "broken.md"), "---\nname: [unterminated\n---\nBROKEN_PAYLOAD");
      const sourcePath = join(root, "valid.md");
      writeFileSync(sourcePath, "VALID_PAYLOAD");
      const [broken, missing, valid] = preloadSkills(["broken", "missing", "valid"], fixture.dir);
      expect(broken).not.toHaveProperty("sourcePath");
      expect(missing).not.toHaveProperty("sourcePath");
      expect(valid).toMatchObject({ sourcePath, content: "VALID_PAYLOAD" });
    } finally {
      fixture.restore();
    }
  });
});
