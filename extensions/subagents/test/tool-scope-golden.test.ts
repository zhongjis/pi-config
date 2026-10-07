/**
 * Data lint — every real agents/<name>.md (except AGENTS.md) and
 * modes/<name>/mode.md (parsed as a Mode Agent) must parse under the shared
 * agent-frontmatter schema with zero invalidFields and zero error
 * diagnostics. Validity only; contents are never asserted.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAgentMarkdown } from "../../lib/agent-frontmatter.js";

// test dir → subagents → extensions → repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Discover every real fleet definition file (agents + modes). */
function discoverFleetFiles(): string[] {
  const files: string[] = [];

  const agentsDir = join(REPO_ROOT, "agents");
  for (const f of readdirSync(agentsDir)) {
    if (f.endsWith(".md") && f !== "AGENTS.md") files.push(join(agentsDir, f));
  }

  const modesDir = join(REPO_ROOT, "modes");
  for (const entry of readdirSync(modesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modeFile = join(modesDir, entry.name, "mode.md");
    try {
      readFileSync(modeFile);
      files.push(modeFile);
    } catch {
      // not every mode dir has a mode.md — skip.
    }
  }

  return files.sort();
}

const FLEET_FILES = discoverFleetFiles();

describe("fleet frontmatter — shared schema acceptance", () => {
  it("discovers fleet files", () => {
    // Guard against the glob silently finding nothing (which would vacuously pass).
    expect(FLEET_FILES.length).toBeGreaterThan(0);
  });

  it.each(FLEET_FILES)("%s parses with ZERO invalidFields and error diagnostics", (file) => {
    const kind = file.endsWith(`${sep}mode.md`) ? "mode" : "subagent";
    const parsed = parseAgentMarkdown(readFileSync(file, "utf-8"), { kind });
    expect({
      invalidFields: parsed.invalidFields,
      errors: parsed.diagnostics.filter((d) => d.severity === "error"),
    }).toEqual({ invalidFields: [], errors: [] });
  });
});
