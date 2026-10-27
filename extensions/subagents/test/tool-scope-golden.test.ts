/**
 * Data lint — flat agents/*.md definitions (except AGENTS.md) and
 * agents/<name>/default.md or modes/<name>/default.md must parse under the
 * shared agent-frontmatter schema with zero invalidFields and zero error
 * diagnostics. Validity only; contents are never asserted.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAgentMarkdown } from "../../lib/agent-frontmatter.js";

// test dir → subagents → extensions → repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Discover every real fleet definition file (agents + modes). */
function discoverFleetFiles(): string[] {
  const files: string[] = [];
  for (const root of ["agents", "modes"]) {
    const dir = join(REPO_ROOT, root);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (root === "agents" && entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md") {
        files.push(join(dir, entry.name));
      }
      if (entry.isDirectory()) {
        const defaultFile = join(dir, entry.name, "default.md");
        if (existsSync(defaultFile)) files.push(defaultFile);
      }
    }
  }
  return files.sort();
}

const FLEET_FILES = discoverFleetFiles();

function isModeFile(file: string): boolean {
  return relative(REPO_ROOT, file).split(sep)[0] === "modes";
}

describe("fleet frontmatter — shared schema acceptance", () => {
  it("discovers fleet and mode definitions", () => {
    // Guard against silent coverage loss from renamed or moved definitions.
    expect(FLEET_FILES.length).toBeGreaterThan(0);
    expect(FLEET_FILES.some(isModeFile)).toBe(true);
  });

  it.each(FLEET_FILES)("%s parses with ZERO invalidFields and error diagnostics", (file) => {
    const kind = isModeFile(file) ? "mode" : "subagent";
    const parsed = parseAgentMarkdown(readFileSync(file, "utf-8"), { kind });
    expect({
      invalidFields: parsed.invalidFields,
      errors: parsed.diagnostics.filter((d) => d.severity === "error"),
    }).toEqual({ invalidFields: [], errors: [] });
  });
});
