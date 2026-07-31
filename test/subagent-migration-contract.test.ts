import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(__dirname, "..");
const RETIRED_SOURCE_PREFIX = `extensions/${"subagent"}/`;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|mjs|yaml)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("subagent migration contract", () => {
  it("keeps active tests, scripts, and workspace config off the retired source tree", () => {
    const candidates = [
      ...sourceFiles(join(PROJECT_ROOT, "test")),
      ...sourceFiles(join(PROJECT_ROOT, "scripts")),
      join(PROJECT_ROOT, "pnpm-workspace.yaml"),
    ];
    const offenders = candidates
      .filter((path) => readFileSync(path, "utf8").includes(RETIRED_SOURCE_PREFIX))
      .map((path) => relative(PROJECT_ROOT, path))
      .sort();

    expect(offenders).toEqual([]);
  });
});
