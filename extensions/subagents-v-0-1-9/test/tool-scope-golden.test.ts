/**
 * Golden test — the WHOLE panda fleet must parse cleanly under the SHARED
 * agent-frontmatter schema, and their authored builtin_tools/extension_tools
 * must resolve to the intended active tool set through the SHARED
 * computeActiveToolNames engine.
 *
 * This is the fleet-acceptance guard for the subagents → shared-schema
 * migration: every real agents/<name>.md (except AGENTS.md) and modes/<name>/mode.md
 * must produce ZERO invalidFields. A non-empty invalidFields for any file means
 * the shared parser rejects a fleet agent — a real problem, not a test bug.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeActiveToolNames, DEFAULT_BUILTIN_TOOL_NAMES } from "../../lib/active-tools.js";
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

/**
 * Representative available-tool universe: the built-ins plus a spread of the
 * extension tools the fleet actually references. computeActiveToolNames output
 * order follows this list.
 */
const AVAILABLE_TOOL_NAMES = [
  ...DEFAULT_BUILTIN_TOOL_NAMES,
  "codegraph_search",
  "codegraph_explore",
  "lsp",
  "look_at",
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
  "mcporter",
  "Agent",
  "get_subagent_result",
  "steer_subagent",
];

function activeFor(file: string): string[] {
  const parsed = parseAgentMarkdown(readFileSync(join(REPO_ROOT, file), "utf-8"));
  return computeActiveToolNames({
    availableToolNames: AVAILABLE_TOOL_NAMES,
    builtinToolNames: parsed.builtinToolNames,
    builtinToolUniverse: DEFAULT_BUILTIN_TOOL_NAMES,
    extensions: parsed.extensions,
    extensionTools: parsed.extensionToolNames,
    allowNesting: parsed.allowNesting,
    isolated: parsed.isolated,
  });
}

const FLEET_FILES = discoverFleetFiles();

describe("fleet frontmatter — shared schema acceptance", () => {
  it("discovers the expected fleet (10 agents + 5 modes)", () => {
    // Guard against the glob silently finding nothing (which would vacuously pass).
    expect(FLEET_FILES.length).toBeGreaterThanOrEqual(15);
  });

  it.each(FLEET_FILES)("%s parses with ZERO invalidFields", (file) => {
    const parsed = parseAgentMarkdown(readFileSync(file, "utf-8"));
    // A non-empty invalidFields means the shared schema rejects a fleet agent.
    expect(parsed.invalidFields).toEqual([]);
  });
});

describe("fleet frontmatter — computeActiveToolNames matches authored intent", () => {
  it("jintong → read,bash,edit,write,codegraph_*,lsp (no nesting)", () => {
    const active = activeFor("agents/jintong.md");
    expect(new Set(active)).toEqual(
      new Set(["read", "bash", "edit", "write", "codegraph_search", "codegraph_explore", "lsp"]),
    );
    expect(active).not.toContain("grep"); // not in builtin_tools
    expect(active).not.toContain("Agent"); // no allow_nesting
  });

  it("guangguang → read,bash,edit,write,lsp", () => {
    const active = activeFor("agents/guangguang.md");
    expect(new Set(active)).toEqual(new Set(["read", "bash", "edit", "write", "lsp"]));
    expect(active).not.toContain("codegraph_search");
  });

  it.each([
    ["chengfeng", ["read", "bash", "codegraph_search", "codegraph_explore", "lsp"]],
    ["direnjie", ["read", "bash", "codegraph_search", "codegraph_explore", "lsp"]],
    ["taishang", ["read", "bash", "look_at", "codegraph_search", "codegraph_explore", "lsp"]],
    ["xuannv", ["read", "bash", "codegraph_search", "codegraph_explore", "lsp", "Agent", "get_subagent_result", "steer_subagent"]],
    ["yanluo", ["read", "bash", "codegraph_search", "codegraph_explore", "lsp"]],
  ] as const)("%s → guarded built-in bash with role tools preserved", (agent, expected) => {
    const active = activeFor(`agents/${agent}.md`);
    expect(new Set(active)).toEqual(new Set(expected));
    expect(active).not.toContain("edit");
    expect(active).not.toContain("write");
  });
});
