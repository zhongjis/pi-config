/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/, plus the shared .agents/agents/ workspace) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  invalidFrontmatterFieldMessage,
  parseAgentMarkdown,
} from "../../lib/agent-frontmatter.js";
import type {
  AgentConfig,
  AgentDefinitionDiagnostic,
  CustomAgentsLoadResult,
} from "./types.js";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project:   <cwd>/.pi/agents/*.md (authoritative — also where /agents writes)
 *   2. Workspace: <cwd>/.agents/agents/*.md (shared cross-tool .agents workspace, read-only)
 *   3. Global:    $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name. On a name clash
 * between the two project locations, .pi/agents wins — .pi stays the project
 * authority; .agents/agents is an additional read location.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(cwd: string, _strict?: boolean): Map<string, AgentConfig> {
  return loadCustomAgentsWithDiagnostics(cwd).agents;
}

/** Scan for custom agents and return structured frontmatter diagnostics. */
export function loadCustomAgentsWithDiagnostics(cwd: string): CustomAgentsLoadResult {
  const globalDir = join(getAgentDir(), "agents");
  const workspaceProjectDir = join(cwd, ".agents", "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  const diagnostics: AgentDefinitionDiagnostic[] = [];
  loadFromDir(globalDir, agents, diagnostics, "global");            // lowest priority
  loadFromDir(workspaceProjectDir, agents, diagnostics, "project"); // shared workspace
  loadFromDir(projectDir, agents, diagnostics, "project");          // highest priority (overwrites)
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
    files = readdirSync(dir).filter(f => f.endsWith(".md") && f !== "AGENTS.md");
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

    const parsed = parseAgentMarkdown(content);
    for (const field of parsed.invalidFields) {
      diagnostics.push({
        file: filePath,
        agentName: name,
        field,
        severity: "error",
        message: invalidFrontmatterFieldMessage(field),
      });
    }
    // Obsolete tool/skill selection fields make the definition invalid: skip it
    // rather than misconfigure a worker with a silently-ignored allowlist.
    if (parsed.invalidFields.length > 0) continue;

    // NEW-local fields the shared schema does not model. Parsed directly from
    // the raw frontmatter. `thinking` is normalized (legacy "none" -> "off")
    // via a local helper.
    const fm = parsed.frontmatter;

    agents.set(name, {
      name,
      displayName: parsed.displayName,
      description: parsed.description ?? name,
      builtinToolNames: parsed.builtinToolNames,
      extensionToolNames: parsed.extensionToolNames,
      allowDelegationTo: parsed.allowDelegationTo,
      disallowDelegationTo: parsed.disallowDelegationTo,
      allowNesting: parsed.allowNesting,
      extensions: parsed.extensions,
      excludeExtensions: parsed.excludeExtensions,
      discoverSkills: parsed.discoverSkills,
      preloadSkills: parsed.preloadSkills,
      skills: true, // legacy field, kept for type compat; actual skill loading uses discoverSkills/preloadSkills
      model: parsed.model,
      thinking: normalizeThinking(fm.thinking),
      maxTurns: parsed.maxTurns,
      persistSession: fm.persist_session != null ? fm.persist_session === true : undefined,
      outputTranscript: fm.output_transcript != null ? fm.output_transcript !== false : undefined,
      sessionDir: str(fm.session_dir),
      systemPrompt: parsed.body.trim(),
      promptMode: parsed.promptMode,
      inheritContext: parsed.inheritContext,
      runInBackground: parsed.runInBackground,
      isolated: parsed.isolated,
      enabled: parsed.enabled,
      source,
    });
  }
}

/** Normalize thinking level: "none" → "off", everything else passes through. */
function normalizeThinking(val: unknown): import("./types.js").ThinkingLevel | undefined {
  if (typeof val !== "string" || !val) return undefined;
  return (val === "none" ? "off" : val) as import("./types.js").ThinkingLevel;
}

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** Parse raw agent file content (YAML frontmatter + body). Re-export for agent-file-toggle. */
export function parseAgentFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string } {
  return parseFrontmatter<T>(content.startsWith("\uFEFF") ? content.slice(1) : content);
}
