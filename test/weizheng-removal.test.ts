import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const REMOVED_AGENT = join(ROOT, "agents", "weizheng.md");
const REMOVED_REVIEWER = /\bweizheng\b|Wei Zheng|魏征/i;
const ORCHESTRATOR_GATE = "orchestrator-owned code-quality gate";

const ACTIVE_PROMPT_AND_CONTRACT_ROOTS = [
  "agents",
  "modes",
  "docs/specs",
  "extensions/ulw",
  ".pi/skills/faithfully-awesome-omo",
  ".agents/skills/faithfully-awesome-omo",
];

const SINGLE_CONTRACT_FILES = ["CONTEXT.md", "extensions/subagent/AGENTS.md"];

const ORCHESTRATOR_GATE_FILES = [
  "modes/fuxi/mode.md",
  "modes/fuxi/gpt.md",
  "modes/fuxi/references/full-workflow.md",
  "modes/houtu/mode.md",
  "modes/houtu/gpt.md",
  "modes/kuafu/mode.md",
  "modes/kuafu/gpt.md",
  "modes/luban/mode.md",
  "modes/luban/gpt.md",
  "extensions/ulw/prompts/default.md",
  "extensions/ulw/prompts/gpt.md",
];

function markdownFiles(relativeRoot: string): string[] {
  const absoluteRoot = join(ROOT, relativeRoot);
  return readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function repoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("Wei Zheng removal contract", () => {
  it("removes the custom agent definition", () => {
    expect(existsSync(REMOVED_AGENT)).toBe(false);
  });

  it("leaves no active prompt, allowlist, or contract route to the removed reviewer", () => {
    const files = [
      ...ACTIVE_PROMPT_AND_CONTRACT_ROOTS.flatMap(markdownFiles),
      ...SINGLE_CONTRACT_FILES.map((path) => join(ROOT, path)),
    ];

    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(REMOVED_REVIEWER);
    }
  });

  it("keeps code-quality review as an explicit orchestrator-owned gate", () => {
    for (const file of ORCHESTRATOR_GATE_FILES) {
      expect(repoFile(file), file).toContain(ORCHESTRATOR_GATE);
    }
  });
});
