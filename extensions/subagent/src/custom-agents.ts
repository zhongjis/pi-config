/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import type {
  AgentConfig,
  AgentDefinitionDiagnostic,
  CustomAgentsLoadResult,
  MemoryScope,
} from "./types.js";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project: <cwd>/.pi/agents/*.md
 *   2. Global:  $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  return loadCustomAgentsWithDiagnostics(cwd).agents;
}

/** Scan for custom agents and return structured frontmatter diagnostics. */
export function loadCustomAgentsWithDiagnostics(cwd: string): CustomAgentsLoadResult {
  const globalDir = join(getAgentDir(), "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  const diagnostics: AgentDefinitionDiagnostic[] = [];
  loadFromDir(globalDir, agents, diagnostics, "global");   // lower priority
  loadFromDir(projectDir, agents, diagnostics, "project");  // higher priority (overwrites)
  return { agents, diagnostics };
}

/** Load agent configs from a directory into the map. */
function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  diagnostics: AgentDefinitionDiagnostic[],
  source: "project" | "global",
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch {
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");
    const filePath = join(dir, file);

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);
    const invalidFields = invalidFrontmatterFields(fm);
    for (const field of invalidFields) {
      diagnostics.push({
        file: filePath,
        agentName: name,
        field,
        severity: "error",
        message: invalidFrontmatterFieldMessage(field),
      });
    }
    if (invalidFields.length > 0) continue;

    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      description: str(fm.description) ?? name,
      builtinToolNames: parseBuiltinTools(fm),
      extensionToolNames: csvListOptionalWithNone(fm.extension_tools),
      allowDelegationTo: csvListOptional(fm.allow_delegation_to),
      disallowDelegationTo: csvListOptional(fm.disallow_delegation_to),
      allowNesting: fm.allow_nesting === true,
      extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
      skills: inheritField(fm.skills ?? fm.inherit_skills),
      model: str(fm.model),
      maxTurns: nonNegativeInt(fm.max_turns),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
      isolated: fm.isolated != null ? fm.isolated === true : undefined,
      memory: parseMemory(fm.memory),
      isolation: fm.isolation === "worktree" ? "worktree" : undefined,
      enabled: fm.enabled !== false,  // default true; explicitly false disables
      source,
    });
  }
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

/** True when a frontmatter object explicitly includes a key. */
function hasField(fm: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(fm, field);
}

/** Obsolete frontmatter fields make the definition invalid. */
function invalidFrontmatterFields(fm: Record<string, unknown>): string[] {
  return ["tools", "disallowed_tools", "disallow_tools"].filter(field => hasField(fm, field));
}

function invalidFrontmatterFieldMessage(field: string): string {
  if (field === "tools") {
    return "tools is invalid/obsolete; use builtin_tools for built-in tools and extension_tools for extension/custom tools instead.";
  }

  return `${field} is invalid/obsolete; use builtin_tools and extension_tools explicit allowlists instead.`;
}

/** Keep only canonical built-in tool names; extension/custom tool names are not built-ins. */
function onlyBuiltinTools(names: string[]): string[] {
  const builtins = new Set(BUILTIN_TOOL_NAMES);
  return names.filter(name => builtins.has(name));
}

/** Parse builtin_tools. */
function parseBuiltinTools(fm: Record<string, unknown>): string[] {
  if (hasField(fm, "builtin_tools")) {
    return onlyBuiltinTools(csvList(fm.builtin_tools, BUILTIN_TOOL_NAMES));
  }

  return [...BUILTIN_TOOL_NAMES];
}

/**
 * Parse a raw CSV field value into items, or undefined if absent/empty/"none".
 */
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map(t => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse a comma-separated list field with defaults.
 * omitted → defaults; "none"/empty → []; csv → listed items.
 */
function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

/**
 * Parse an optional comma-separated list field.
 * omitted → undefined; "none"/empty → undefined; csv → listed items.
 */
function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

/**
 * Parse an optional comma-separated list that distinguishes omitted from none.
 * omitted → undefined; "none"/empty → []; csv → listed items.
 */
function csvListOptionalWithNone(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  return parseCsvField(val) ?? [];
}

/**
 * Parse a memory scope field.
 * omitted → undefined; "user"/"project"/"local" → MemoryScope.
 */
function parseMemory(val: unknown): MemoryScope | undefined {
  if (val === "user" || val === "project" || val === "local") return val;
  return undefined;
}

/**
 * Parse an inherit field (extensions, skills).
 * omitted/true → true (inherit all); false/"none"/empty → false; csv → listed names.
 */
function inheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}
