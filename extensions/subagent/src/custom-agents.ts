/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
    if (parsed.invalidFields.length > 0) continue;

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
      model: parsed.model,
      maxTurns: parsed.maxTurns,
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

